/// Integer money in minor units (santim for ETB). Never a `double`.
///
/// Matches the API representation `{ "amountMinor": 150000, "currency": "ETB" }`
/// (docs/architecture/04-api-architecture.md).
final class Money {
  /// Creates an amount of [amountMinor] minor units in [currency].
  Money(this.amountMinor, this.currency) {
    if (!supportedCurrencies.contains(currency)) {
      throw ArgumentError.value(currency, 'currency', 'Unsupported currency');
    }
    if (amountMinor.abs() > maxSafeMinor) {
      throw ArgumentError.value(
        amountMinor,
        'amountMinor',
        'Out of safe range',
      );
    }
  }

  /// Creates an ETB amount from santim.
  factory Money.etb(int amountMinor) => Money(amountMinor, etbCode);

  /// Parses an API money object. Rejects floats, strings and unknown currencies.
  factory Money.fromJson(Map<String, Object?> json) {
    final amount = json['amountMinor'];
    final currency = json['currency'];
    if (amount is! int || currency is! String) {
      throw const FormatException(
        'Money requires integer amountMinor and string currency',
      );
    }
    return Money(amount, currency);
  }

  static const String etbCode = 'ETB';
  static const Set<String> supportedCurrencies = {etbCode};

  /// Largest integer exactly representable on every Dart platform, including web.
  static const int maxSafeMinor = 9007199254740991;

  final int amountMinor;
  final String currency;

  Map<String, Object> toJson() => {
    'amountMinor': amountMinor,
    'currency': currency,
  };

  Money operator +(Money other) =>
      Money(amountMinor + _same(other).amountMinor, currency);
  Money operator -(Money other) =>
      Money(amountMinor - _same(other).amountMinor, currency);

  bool get isNegative => amountMinor < 0;

  Money _same(Money other) {
    if (other.currency != currency) {
      throw ArgumentError('Cannot combine $currency with ${other.currency}');
    }
    return other;
  }

  @override
  bool operator ==(Object other) =>
      other is Money &&
      other.amountMinor == amountMinor &&
      other.currency == currency;

  @override
  int get hashCode => Object.hash(amountMinor, currency);

  @override
  String toString() => 'Money($amountMinor $currency)';
}
