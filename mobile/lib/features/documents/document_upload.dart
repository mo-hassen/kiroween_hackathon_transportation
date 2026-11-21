import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/session_controller.dart';
import '../../core/network/api_client.dart';
import '../../core/network/api_failure.dart';
import '../driver/data/driver_api.dart' show DocumentInfo, UploadIntent, UploadStatus;
import '../driver/data/license_upload.dart'
    show ObjectUploader, PhotoRejected, PickedPhoto, UploadStage;

/// The two `/documents` calls every upload needs (Phase 5 pipeline): an intent with a
/// presigned PUT, then the server check (type, checksum, metadata removal, malware scan).
abstract interface class DocumentUploadApi {
  Future<UploadIntent> createUpload({
    required String purpose,
    required String mimeType,
    required int sizeBytes,
    required String sha256,
  });

  Future<DocumentInfo> completeUpload(String documentId);
}

Map<String, Object?> _map(Object? value) => (value! as Map).cast<String, Object?>();

final class HttpDocumentUploadApi implements DocumentUploadApi {
  const HttpDocumentUploadApi(this._client);

  final ApiClient _client;

  @override
  Future<UploadIntent> createUpload({
    required String purpose,
    required String mimeType,
    required int sizeBytes,
    required String sha256,
  }) => _client.post(
    '/documents',
    body: {'purpose': purpose, 'mimeType': mimeType, 'sizeBytes': sizeBytes, 'sha256': sha256},
    // A retried intent would only create an unused document; never repeat automatically.
    noRetry: true,
    decode: (data) => UploadIntent.fromJson(_map(data)),
  );

  @override
  Future<DocumentInfo> completeUpload(String documentId) => _client.post(
    '/documents/${Uri.encodeComponent(documentId)}/complete',
    decode: (data) => DocumentInfo.fromJson(_map(data)),
  );
}

final documentUploadApiProvider = Provider<DocumentUploadApi>(
  (ref) => HttpDocumentUploadApi(ref.watch(apiClientProvider)),
);

/// One document upload up to an AVAILABLE document: intent, PUT to storage, server check.
///
/// A job remembers how far it got, so [run] after a failure resumes there: a scanner outage
/// repeats only the check; `UPLOAD_NOT_FOUND` sends the bytes again; a refused file
/// ([PhotoRejected]) cannot be retried and needs a new photo.
final class DocumentUploadJob {
  DocumentUploadJob({
    required this.api,
    required this.uploader,
    required this.purpose,
    required this.photo,
  });

  final DocumentUploadApi api;
  final ObjectUploader uploader;
  final String purpose;
  final PickedPhoto photo;

  String? _documentId;
  bool _sent = false;
  DocumentInfo? _available;

  /// Returns the id of the AVAILABLE document.
  Future<String> run({
    required void Function(UploadStage stage, double progress) onProgress,
  }) async {
    if (_available != null) return _available!.id;
    if (_documentId == null || !_sent) {
      onProgress(UploadStage.sending, 0);
      final intent = await api.createUpload(
        purpose: purpose,
        mimeType: photo.mimeType,
        sizeBytes: photo.bytes.length,
        sha256: sha256.convert(photo.bytes).toString(),
      );
      _documentId = intent.document.id;
      await uploader.put(
        intent.url,
        intent.headers,
        photo.bytes,
        onProgress: (value) => onProgress(UploadStage.sending, value),
      );
      _sent = true;
    }
    onProgress(UploadStage.checking, 1);
    final DocumentInfo document;
    try {
      document = await api.completeUpload(_documentId!);
    } on ConflictFailure catch (failure) {
      // The bytes never reached storage (or the upload window passed): send them again.
      if (failure.code == 'UPLOAD_NOT_FOUND') _sent = false;
      rethrow;
    }
    switch (document.status) {
      case UploadStatus.available:
        _available = document;
        return document.id;
      case UploadStatus.invalid || UploadStatus.infected:
        throw PhotoRejected(document.failureCode ?? 'MALFORMED_FILE');
      default:
        throw const ServerFailure(code: 'DOCUMENT_PROCESSING');
    }
  }
}
