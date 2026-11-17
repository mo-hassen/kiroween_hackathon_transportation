import type { Locale } from '../../generated/prisma/client.js';

/**
 * Server-rendered SMS texts. Short (one SMS segment where possible) and never containing
 * anything but the code itself. [REVIEW] Amharic texts need native-speaker review.
 */
export type SmsTemplate =
  'otp.register' | 'otp.password_reset' | 'otp.login_step_up' | 'account.exists';

const TEXTS: Record<SmsTemplate, Record<Locale, (code: string) => string>> = {
  'otp.register': {
    en: (code) =>
      `Kiroween Mobility: your sign-up code is ${code}. It expires in 5 minutes. Never share it.`,
    am: (code) => `Kiroween Mobility: የምዝገባ ኮድዎ ${code} ነው። በ5 ደቂቃ ውስጥ ጊዜው ያልፋል። ለማንም አያጋሩ።`,
  },
  'otp.password_reset': {
    en: (code) =>
      `Kiroween Mobility: your password reset code is ${code}. It expires in 5 minutes. Never share it.`,
    am: (code) =>
      `Kiroween Mobility: የይለፍ ቃል መቀየሪያ ኮድዎ ${code} ነው። በ5 ደቂቃ ውስጥ ጊዜው ያልፋል። ለማንም አያጋሩ።`,
  },
  'otp.login_step_up': {
    en: (code) =>
      `Kiroween Mobility: your sign-in code for a new device is ${code}. If this was not you, change your password.`,
    am: (code) => `Kiroween Mobility: ለአዲስ መሣሪያ የመግቢያ ኮድዎ ${code} ነው። እርስዎ ካልሆኑ የይለፍ ቃልዎን ይቀይሩ።`,
  },
  'account.exists': {
    en: () =>
      'Kiroween Mobility: someone tried to sign up with this number, but you already have an account. Sign in or reset your password.',
    am: () => 'Kiroween Mobility: በዚህ ቁጥር ለመመዝገብ ተሞክሯል፣ ነገር ግን መለያ አለዎት። ይግቡ ወይም የይለፍ ቃልዎን ይቀይሩ።',
  },
};

export function renderSms(template: SmsTemplate, locale: Locale, code = ''): string {
  return TEXTS[template][locale](code);
}
