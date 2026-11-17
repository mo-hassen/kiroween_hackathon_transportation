import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_failure.dart';
import 'state_views.dart';

/// Renders the five UI states every data screen must handle
/// (docs/architecture/06-flutter-architecture.md):
///
/// * loading  – no data yet,
/// * data     – latest data,
/// * empty    – data that [isEmpty] reports as empty,
/// * error    – failure without previous data, with retry,
/// * offline  – connectivity failure while previous data exists: the data is
///              kept on screen under an [OfflineBanner].
class AsyncValueView<T> extends StatelessWidget {
  const AsyncValueView({
    super.key,
    required this.value,
    required this.data,
    this.isEmpty,
    this.empty,
    this.loading,
    this.onRetry,
  });

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final bool Function(T data)? isEmpty;
  final Widget? empty;
  final Widget? loading;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    if (value.hasError) {
      final failure = ApiFailure.from(value.error!);
      if (value.hasValue && failure.isConnectivity) {
        return _OfflineContent(
          banner: OfflineBanner(onRetry: onRetry),
          child: _dataOrEmpty(value.requireValue),
        );
      }
      return ErrorView(failure: failure, onRetry: onRetry);
    }
    if (value.hasValue) {
      return _dataOrEmpty(value.requireValue);
    }
    return loading ?? const LoadingView();
  }

  Widget _dataOrEmpty(T current) {
    if (isEmpty?.call(current) ?? false) {
      return empty ?? const EmptyView();
    }
    return data(current);
  }
}

class _OfflineContent extends StatelessWidget {
  const _OfflineContent({required this.banner, required this.child});

  final Widget banner;
  final Widget child;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => constraints.hasBoundedHeight
        ? Column(
            children: [
              banner,
              Expanded(child: child),
            ],
          )
        : Column(mainAxisSize: MainAxisSize.min, children: [banner, child]),
  );
}
