import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/network/api_client.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/driver/data/driver_api.dart';
import 'package:mobility/features/driver/data/license_upload.dart';
import 'package:mobility/features/driver/presentation/license_form_screen.dart';

import '../../helpers/driver_fakes.dart';
import '../../helpers/fake_http_adapter.dart';

Map<String, Object?> _documentJson(String id) => {
  'id': id,
  'purpose': 'DRIVER_LICENSE_FRONT',
  'uploadStatus': 'AVAILABLE',
  'reviewStatus': 'REJECTED',
  'mimeType': 'image/jpeg',
  'sizeBytes': 1000,
  'failureCode': null,
  'createdAt': '2026-11-18T09:00:00.000Z',
  'processedAt': '2026-11-18T09:00:05.000Z',
};

Map<String, Object?> _licenseJson() => {
  'id': 'lic-1',
  'licenseNumberMasked': '••••3456',
  'categories': ['B', 'C1'],
  'issuedOn': '2022-03-01',
  'expiresOn': '2030-03-01',
  'issuingAuthority': 'Addis Ababa',
  'reviewStatus': 'REJECTED',
  'submittedAt': '2026-11-18T09:00:00.000Z',
  'decidedAt': '2026-11-18T10:00:00.000Z',
  'decisionReasonCode': 'BLURRY',
  'decisionNote': '<b>retake</b>',
  'frontDocument': _documentJson('d1'),
  'backDocument': null,
  'editable': true,
  'version': 3,
};

void main() {
  group('models', () {
    test('parses the /drivers/me response', () {
      final profile = DriverProfile.fromJson({
        'id': 'p1',
        'yearsLicensed': 4,
        'bio': null,
        'homeSubCity': 'BOLE',
        'identityStatus': 'VERIFIED',
        'eligibility': {
          'status': 'INELIGIBLE',
          'blockers': ['LICENSE_NOT_APPROVED'],
        },
        'suspendedReason': null,
        'license': _licenseJson(),
        'version': 2,
      });
      expect(profile.eligibility, Eligibility.ineligible);
      expect(profile.blockers, ['LICENSE_NOT_APPROVED']);
      final license = profile.license!;
      expect(license.status, ReviewStatus.rejected);
      expect(license.decisionNote, '<b>retake</b>');
      expect(
        license.front!.usableForSubmission,
        isFalse,
        reason: 'decided documents cannot be reused',
      );
      expect(license.back, isNull);
      expect(license.readyToSubmit, isFalse);
      expect(ReviewStatus.parse('NEW_STATUS'), ReviewStatus.unknown);
    });

    test('detects JPEG, PNG and WebP by magic bytes only', () {
      expect(detectImageType(jpegBytes), 'image/jpeg');
      expect(
        detectImageType(Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0])),
        'image/png',
      );
      expect(
        detectImageType(
          Uint8List.fromList([...ascii.encode('RIFF'), 0, 0, 0, 0, ...ascii.encode('WEBP')]),
        ),
        'image/webp',
      );
      expect(detectImageType(Uint8List.fromList(ascii.encode('%PDF-1.7'))), isNull);
      expect(detectImageType(Uint8List(0)), isNull);
    });

    test('licence number and category rules match the API', () {
      expect(normalizeLicenseNumber('aa-12 34/5.6'), 'AA123456');
      expect(normalizeLicenseNumber('ab1'), isNull);
      expect(normalizeLicenseNumber('A' * 21), isNull);
      expect(normalizeLicenseNumber('AB12#4'), isNull);
      expect(parseCategories('b, c1 ,Public-1'), ['B', 'C1', 'PUBLIC-1']);
      expect(parseCategories(''), isNull);
      expect(parseCategories('B, b'), isNull, reason: 'duplicates');
      expect(parseCategories('-B'), isNull);
      expect(parseCategories(List.generate(11, (i) => 'C$i').join(',')), isNull);
    });
  });

  group('HttpDriverApi', () {
    late FakeHttpAdapter adapter;
    HttpDriverApi api(List<FakeHandler> handlers) {
      adapter = FakeHttpAdapter(handlers);
      final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
      return HttpDriverApi(ApiClient(dio));
    }

    test('a missing driver profile (404) is null, not an error', () async {
      expect(await api([respond(problem('NOT_FOUND', 404), 404)]).profile(), isNull);
    });

    test('updates send If-Match, attach uses PUT, submit sends the Idempotency-Key', () async {
      final client = api([
        respond({'data': _licenseJson()}, 200),
        respond({'data': _licenseJson()}, 200),
        respond({'data': _licenseJson()}, 200),
      ]);
      const input = LicenseInput(
        licenseNumber: 'AA123456',
        categories: ['B'],
        issuedOn: '2022-03-01',
        expiresOn: '2030-03-01',
        issuingAuthority: 'Addis Ababa',
      );
      await client.updateLicense('lic-1', 3, input);
      await client.attach('lic-1', LicenseSide.back, 'd2');
      await client.submit('lic-1', idempotencyKey: 'key-1');

      expect(adapter.requests[0].method, 'PATCH');
      expect(adapter.sentHeaders[0]['If-Match'], '3');
      expect((adapter.requests[0].data as Map)['licenseNumber'], 'AA123456');
      expect(adapter.requests[1].method, 'PUT');
      expect(adapter.requests[1].path, '/drivers/me/licenses/lic-1/documents/back');
      expect(adapter.requests[1].data, {'documentId': 'd2'});
      expect(adapter.requests[2].path, '/drivers/me/licenses/lic-1/submit');
      expect(adapter.sentHeaders[2]['Idempotency-Key'], 'key-1');
    });

    test('a duplicate licence number keeps its code for the UI', () async {
      final client = api([respond(problem('LICENSE_NUMBER_IN_USE', 409), 409)]);
      const input = LicenseInput(
        licenseNumber: 'AA123456',
        categories: ['B'],
        issuedOn: '2022-03-01',
        expiresOn: '2030-03-01',
        issuingAuthority: 'Addis Ababa',
      );
      await expectLater(
        client.createLicense(input),
        throwsA(isA<ConflictFailure>().having((f) => f.code, 'code', 'LICENSE_NUMBER_IN_USE')),
      );
    });
  });

  group('DioObjectUploader', () {
    test(
      'PUTs the bytes with the signed headers and an exact Content-Length, no Authorization',
      () async {
        final adapter = FakeHttpAdapter([(_) => ResponseBody.fromString('', 200)]);
        final dio = Dio()..httpClientAdapter = adapter;
        final progress = <double>[];
        await DioObjectUploader(dio).put(
          Uri.parse('https://storage.test/incoming/d1?X-Amz-Signature=abc'),
          const {'Content-Type': 'image/jpeg'},
          jpegBytes,
          onProgress: progress.add,
        );
        final request = adapter.requests.single;
        expect(request.method, 'PUT');
        expect(request.uri.toString(), 'https://storage.test/incoming/d1?X-Amz-Signature=abc');
        expect(adapter.sentHeaders.single['Content-Type'], 'image/jpeg');
        expect(adapter.sentHeaders.single[Headers.contentLengthHeader], jpegBytes.length);
        expect(adapter.sentHeaders.single.containsKey('Authorization'), isFalse);
      },
    );

    test('a storage error becomes an ApiFailure', () async {
      final adapter = FakeHttpAdapter([connectionError()]);
      final dio = Dio()..httpClientAdapter = adapter;
      await expectLater(
        DioObjectUploader(dio).put(Uri.parse('https://storage.test/x'), const {}, jpegBytes),
        throwsA(isA<NetworkFailure>()),
      );
    });
  });

  group('LicenseUploadJob', () {
    late FakeDriverApi api;
    late FakeObjectUploader uploader;
    LicenseUploadJob job() => LicenseUploadJob(
      api: api,
      uploader: uploader,
      licenseId: 'lic-1',
      side: LicenseSide.front,
      photo: PickedPhoto(bytes: jpegBytes, mimeType: 'image/jpeg'),
    );

    setUp(() {
      api = FakeDriverApi(current: driverProfile(license: license()));
      uploader = FakeObjectUploader();
    });

    test('intent with SHA-256 and size, PUT, check, attach', () async {
      final stages = <UploadStage>[];
      final result = await job().run(onProgress: (stage, _) => stages.add(stage));
      final digest = sha256.convert(jpegBytes).toString();
      expect(api.calls, [
        'createUpload:DRIVER_LICENSE_FRONT:image/jpeg:${jpegBytes.length}:$digest',
        'complete:doc-1',
        'attach:front:doc-1',
      ]);
      expect(uploader.puts, [
        'https://storage.test/incoming/doc-1?sig=1:image/jpeg:${jpegBytes.length}',
      ]);
      expect(stages.toSet(), {UploadStage.sending, UploadStage.checking, UploadStage.attaching});
      expect(result.front!.id, 'doc-1');
    });

    test('a scanner outage retries only the check, not the upload', () async {
      api.completeResults.add(const ServerFailure(code: 'DOCUMENT_SCAN_UNAVAILABLE'));
      final upload = job();
      await expectLater(upload.run(onProgress: (_, _) {}), throwsA(isA<ServerFailure>()));
      await upload.run(onProgress: (_, _) {});
      expect(uploader.puts, hasLength(1));
      expect(api.calls.where((c) => c.startsWith('createUpload')), hasLength(1));
      expect(api.calls.where((c) => c.startsWith('complete')), hasLength(2));
    });

    test('a failed PUT starts again with a new intent', () async {
      uploader.failNext = const NetworkFailure();
      final upload = job();
      await expectLater(upload.run(onProgress: (_, _) {}), throwsA(isA<NetworkFailure>()));
      await upload.run(onProgress: (_, _) {});
      expect(api.calls.where((c) => c.startsWith('createUpload')), hasLength(2));
      expect(api.calls.last, 'attach:front:doc-2');
    });

    test('UPLOAD_NOT_FOUND sends the bytes again', () async {
      api.completeResults.add(const ConflictFailure(code: 'UPLOAD_NOT_FOUND'));
      final upload = job();
      await expectLater(upload.run(onProgress: (_, _) {}), throwsA(isA<ConflictFailure>()));
      await upload.run(onProgress: (_, _) {});
      expect(uploader.puts, hasLength(2));
    });

    test('a refused file is reported with its code and never attached', () async {
      api.completeResults.add(
        doc('doc-1', status: UploadStatus.infected, failureCode: 'MALWARE_DETECTED'),
      );
      await expectLater(
        job().run(onProgress: (_, _) {}),
        throwsA(isA<PhotoRejected>().having((e) => e.code, 'code', 'MALWARE_DETECTED')),
      );
      expect(api.calls.where((c) => c.startsWith('attach')), isEmpty);
    });
  });
}
