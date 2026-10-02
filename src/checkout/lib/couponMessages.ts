/**
 * Hebrew wording for every way a coupon can be refused. The database decides (supabase/migrations/0014_coupons.sql);
 * these are only its tokens made readable. Kept free of any club/RPC code so `ordersApi.ts` (always in the checkout
 * chunk) can use it without pulling the coupon request code into a build that has no club login.
 */
const MESSAGES: Record<string, string> = {
  COUPON_INVALID: "קוד הקופון אינו תקין. בדקו את הקוד ונסו שוב.",
  COUPON_MEMBERS_ONLY: "קופונים זמינים לחברי מועדון בלאגן בלבד. התחברו או הצטרפו כדי להשתמש בהם.",
  COUPON_DISABLED: "הקופון אינו פעיל כרגע.",
  COUPON_NOT_STARTED: "הקופון עדיין לא בתוקף.",
  COUPON_EXPIRED: "תוקף הקופון פג.",
  COUPON_MIN_ORDER: "הקופון תקף להזמנה בסכום גבוה יותר.",
  COUPON_FIRST_ORDER_ONLY: "הקופון מיועד להזמנה ראשונה בלבד.",
  COUPON_EXHAUSTED: "הקופון מוצה ואינו זמין עוד.",
  COUPON_ALREADY_USED: "כבר מימשתם את הקופון הזה.",
  COUPON_NO_BENEFIT: "הקופון אינו מקנה הנחה על הזמנה זו.",
  COUPON_TOO_MANY_ATTEMPTS: "נבדקו יותר מדי קודים. נסו שוב בעוד כמה דקות.",
  COUPON_DROPPED: "הקופון שהוחל כבר אינו תקף והוסר, והסכום עודכן. בדקו את הסכום ואשרו שוב.",
};

export const isCouponErrorCode = (code: string): boolean => code.startsWith("COUPON_");

/** `minSubtotalCents` (when the refusal is a minimum-order one) lets the message name the amount. */
export function describeCouponReason(reason: string, minSubtotalCents?: number | null): string {
  if (reason === "COUPON_MIN_ORDER" && typeof minSubtotalCents === "number" && minSubtotalCents > 0) {
    return `הקופון תקף להזמנה מסכום של ₪${(minSubtotalCents / 100).toFixed(minSubtotalCents % 100 === 0 ? 0 : 2)} ומעלה.`;
  }
  return MESSAGES[reason] ?? "לא ניתן להחיל את הקופון.";
}
