import { useBusinessSettings } from "@/context/BusinessSettingsContext";
import { getIsraelNow, shortTime } from "@/lib/scheduleStatus";

const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** The physical store's full weekly schedule, today highlighted — the content of Hero.tsx's expandable panel. */
export function StoreHoursPanel() {
  const { settings } = useBusinessSettings();
  const todayIndex = getIsraelNow().dayOfWeek;
  const byDay = new Map(settings.store_hours.map((d) => [d.day_of_week, d]));

  return (
    <ul className="flex flex-col gap-0.5 p-2 text-sm">
      {DAY_NAMES.map((name, day) => {
        const d = byDay.get(day);
        const label = d?.is_open && d.open_time && d.close_time ? `${shortTime(d.open_time)}–${shortTime(d.close_time)}` : "סגור";
        const isToday = day === todayIndex;
        return (
          <li
            key={day}
            className={`flex items-center justify-between gap-4 rounded px-2 py-1 ${isToday ? "bg-brand-gold/10 font-semibold text-brand-text" : "text-brand-text-muted"}`}
          >
            <span>{name}</span>
            <span dir="ltr">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
