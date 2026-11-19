import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/session.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/drivers/case_detail_screen.dart';
import '../features/drivers/queue_screen.dart';
import '../features/login/login_screen.dart';
import 'shell.dart';

/// Pure redirect rule (tested directly). Every staff route needs a session; the review
/// screens also need drivers.review. The API enforces both again on every call.
String? staffRedirect(StaffSession session, Uri location) {
  final path = location.path;
  final atLogin = path == '/login';
  final atNoPermission = path == '/no-permission';
  if (session is! SignedIn) return atLogin ? null : '/login';
  if (!session.profile.canReviewDrivers) return atNoPermission ? null : '/no-permission';
  if (atLogin || atNoPermission) return '/';
  return null;
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<StaffSession>(ref.read(staffSessionProvider));
  ref
    ..listen(staffSessionProvider, (_, next) => refresh.value = next)
    ..onDispose(refresh.dispose);
  final router = GoRouter(
    initialLocation: '/',
    refreshListenable: refresh,
    redirect: (context, state) => staffRedirect(ref.read(staffSessionProvider), state.uri),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/no-permission', builder: (_, _) => const NoPermissionScreen()),
      ShellRoute(
        builder: (_, state, child) => AppShell(location: state.uri.path, child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
          GoRoute(
            path: '/drivers',
            builder: (_, state) => QueueScreen(initialStatus: state.uri.queryParameters['status']),
            routes: [
              GoRoute(
                path: ':id',
                builder: (_, state) => CaseDetailScreen(caseId: state.pathParameters['id']!),
              ),
            ],
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
