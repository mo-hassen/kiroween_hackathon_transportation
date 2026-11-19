import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/network/api_client.dart';
import '../../../core/network/api_failure.dart';
import 'driver_api.dart';

/// Same limit as the API (10 MB per document). Photos are compressed well below it.
const maxDocumentBytes = 10 * 1024 * 1024;

/// Longest side after resizing; enough to read a licence, small on mobile data.
const maxPhotoDimension = 2400.0;
const photoQuality = 85;

enum PhotoSource { camera, gallery }

final class PickedPhoto {
  const PickedPhoto({required this.bytes, required this.mimeType});

  final Uint8List bytes;
  final String mimeType;
}

/// JPEG/PNG/WebP from the first bytes, or null. The server checks again (magic bytes).
String? detectImageType(Uint8List bytes) {
  bool startsWith(List<int> prefix) {
    if (bytes.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (bytes[i] != prefix[i]) return false;
    }
    return true;
  }

  if (startsWith(const [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWith(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (bytes.length >= 12 &&
      String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
      String.fromCharCodes(bytes.sublist(8, 12)) == 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/// Why a photo was refused before or after upload.
final class PhotoRejected implements Exception {
  const PhotoRejected(this.code);

  /// `UNSUPPORTED_TYPE`, `TOO_LARGE`, or a server failure code such as `MALFORMED_FILE`.
  final String code;
}

abstract interface class LicensePhotoPicker {
  /// Null when the user cancels.
  Future<PickedPhoto?> pick(PhotoSource source);
}

/// Camera or gallery through the system picker (no storage permission needed on Android).
/// Photos are resized and re-compressed on the device; the server strips all metadata again.
final class SystemPhotoPicker implements LicensePhotoPicker {
  SystemPhotoPicker([ImagePicker? picker]) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  @override
  Future<PickedPhoto?> pick(PhotoSource source) async {
    final file = await _picker.pickImage(
      source: source == PhotoSource.camera ? ImageSource.camera : ImageSource.gallery,
      maxWidth: maxPhotoDimension,
      maxHeight: maxPhotoDimension,
      imageQuality: photoQuality,
      requestFullMetadata: false,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    final type = detectImageType(bytes);
    if (type == null) throw const PhotoRejected('UNSUPPORTED_TYPE');
    if (bytes.length > maxDocumentBytes) throw const PhotoRejected('TOO_LARGE');
    return PickedPhoto(bytes: bytes, mimeType: type);
  }
}

final licensePhotoPickerProvider = Provider<LicensePhotoPicker>((ref) => SystemPhotoPicker());

/// Sends bytes to a presigned storage URL. Never adds the API's Authorization header.
abstract interface class ObjectUploader {
  Future<void> put(
    Uri url,
    Map<String, String> headers,
    Uint8List bytes, {
    void Function(double progress)? onProgress,
  });
}

final class DioObjectUploader implements ObjectUploader {
  DioObjectUploader([Dio? dio])
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              connectTimeout: connectTimeout,
              sendTimeout: sendTimeout,
              receiveTimeout: receiveTimeout,
            ),
          );

  final Dio _dio;

  @override
  Future<void> put(
    Uri url,
    Map<String, String> headers,
    Uint8List bytes, {
    void Function(double progress)? onProgress,
  }) async {
    try {
      await _dio.putUri<void>(
        url,
        data: Stream.value(bytes),
        options: Options(
          headers: {...headers, Headers.contentLengthHeader: bytes.length},
          responseType: ResponseType.plain,
        ),
        onSendProgress: onProgress == null
            ? null
            : (sent, total) => onProgress(total <= 0 ? 0 : sent / total),
      );
    } on DioException catch (error) {
      throw ApiFailure.fromDioException(error);
    }
  }
}

final objectUploaderProvider = Provider<ObjectUploader>((ref) => DioObjectUploader());

enum UploadStage { sending, checking, attaching }

/// One licence photo upload: intent, PUT to storage, server check, attach to the licence.
///
/// A job remembers how far it got, so [run] after a failure resumes there (e.g. the scanner
/// was briefly unavailable: only the check is repeated, the bytes are not sent again).
final class LicenseUploadJob {
  LicenseUploadJob({
    required this.api,
    required this.uploader,
    required this.licenseId,
    required this.side,
    required this.photo,
  });

  final DriverApi api;
  final ObjectUploader uploader;
  final String licenseId;
  final LicenseSide side;
  final PickedPhoto photo;

  String? _documentId;
  bool _sent = false;
  bool _checked = false;

  Future<DriverLicense> run({
    required void Function(UploadStage stage, double progress) onProgress,
  }) async {
    if (_documentId == null || !_sent) {
      onProgress(UploadStage.sending, 0);
      final intent = await api.createUpload(
        purpose: side.purpose,
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
    if (!_checked) {
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
          _checked = true;
        case UploadStatus.invalid || UploadStatus.infected:
          // The stored upload is unusable: a retry must start with a new photo.
          throw PhotoRejected(document.failureCode ?? 'MALFORMED_FILE');
        default:
          throw const ServerFailure(code: 'DOCUMENT_PROCESSING');
      }
    }
    onProgress(UploadStage.attaching, 1);
    return api.attach(licenseId, side, _documentId!);
  }
}
