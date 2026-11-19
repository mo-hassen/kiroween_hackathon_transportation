import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'core/config.dart';

void main() {
  // Fails fast on a missing or unsafe build config (e.g. http outside development).
  final config = AdminConfig.fromEnvironment();
  runApp(
    ProviderScope(
      overrides: [adminConfigProvider.overrideWithValue(config)],
      child: const AdminApp(),
    ),
  );
}
