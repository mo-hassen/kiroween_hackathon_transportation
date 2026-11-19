import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/core/config.dart';
import 'package:kiroween_admin/core/session.dart';
import 'package:kiroween_admin/features/drivers/driver_review_api.dart';

import 'helpers/fake_http_adapter.dart';
import 'helpers/fakes.dart';

void main() {
  test('HttpDriverReviewApi sends the documented request shapes', () async {
    final adapter = FakeHttpAdapter([
      respond({'data': null}, 200),
      respond({'data': null}, 200),
      respond({
        'data': {'url': 'https://storage.test/x?sig=1', 'expiresAt': '2026-11-18T09:01:00Z'},
      }, 200),
      respond({
        'data': {'items': <Object?>[], 'total': 0, 'page': 2, 'limit': 20},
      }, 200),
    ]);
    final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
    final api = HttpDriverReviewApi(ApiClient(dio));

    await api.approve('c/1');
    await api.reject('c1', reasonCode: 'BLURRY', note: 'Retake in daylight');
    final url = await api.documentUrl('c1', 'd1', reason: 'Checking the licence photo');
    final page = await api.list(status: 'SUBMITTED', query: '', page: 2);

    expect(adapter.requests[0].path, '/admin/driver-verifications/c%2F1/approve');
    expect(adapter.requests[0].data, {
      'identityMatches': true,
      'documentsLegible': true,
      'detailsMatch': true,
    });
    expect(adapter.requests[1].data, {'reasonCode': 'BLURRY', 'note': 'Retake in daylight'});
    expect(adapter.requests[2].queryParameters, {'reason': 'Checking the licence photo'});
    expect(url.host, 'storage.test');
    expect(adapter.requests[3].queryParameters, {
      'status': 'SUBMITTED',
      'page': '2',
      'limit': '20',
    });
    expect(page.pages, 1);
  });

  test('server problem codes become ApiFailure without the server message', () async {
    final adapter = FakeHttpAdapter([respond(problem('REVIEW_CLAIMED_BY_OTHER', 409), 409)]);
    final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
    await expectLater(
      HttpDriverReviewApi(ApiClient(dio)).claim('c1'),
      throwsA(
        isA<ApiFailure>()
            .having((f) => f.kind, 'kind', FailureKind.conflict)
            .having((f) => f.code, 'code', 'REVIEW_CLAIMED_BY_OTHER'),
      ),
    );
  });

  test(
    'a 401 refreshes once, retries with the new token, then ends the session on a second 401',
    () async {
      final auth = FakeStaffAuthApi();
      final adapter = FakeHttpAdapter([
        respond(problem('UNAUTHORIZED', 401), 401),
        respond({
          'data': {'SUBMITTED': 1},
        }, 200),
        respond(problem('UNAUTHORIZED', 401), 401),
        respond(problem('UNAUTHORIZED', 401), 401),
      ]);
      final container = ProviderContainer(
        overrides: [
          adminConfigProvider.overrideWithValue(testConfig),
          staffAuthApiProvider.overrideWithValue(auth),
        ],
      );
      addTearDown(container.dispose);
      container.read(authedDioProvider).httpClientAdapter = adapter;
      await container
          .read(staffSessionProvider.notifier)
          .signIn(phone: 'p', password: 'pw', totpCode: '123456');
      final api = HttpDriverReviewApi(container.read(apiClientProvider));

      expect(await api.counts(), {'SUBMITTED': 1});
      expect(adapter.sentHeaders[0]['Authorization'], 'Bearer access-1');
      expect(adapter.sentHeaders[1]['Authorization'], 'Bearer access-2');

      await expectLater(api.counts(), throwsA(isA<ApiFailure>()));
      expect(container.read(staffSessionProvider), isA<SignedOut>());
      expect(container.read(tokenHolderProvider).accessToken, isNull);
    },
  );
}
