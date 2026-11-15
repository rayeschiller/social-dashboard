import { formatMetric, isAvailable, type Provenanced } from "../lib/provenance";
import { provenanceText } from "./format";

interface MetricProps<T> {
  p: Provenanced<T>;
  tz: string;
  format?: (v: T) => string;
  /** Extra sentence appended to the provenance text (e.g. why a metric cannot exist). */
  note?: string;
  className?: string;
}

/** A metric value. Non-available renders exactly "Unavailable"; provenance is in title + screen-reader text. */
export function Metric<T>({ p, tz, format, note, className }: MetricProps<T>) {
  const text = formatMetric(p, format);
  const prov = provenanceText(p, tz, note);
  return (
    <span
      className={`metric${isAvailable(p) ? "" : " is-unavailable"}${className ? ` ${className}` : ""}`}
      title={prov}
      tabIndex={0}
    >
      {text}
      <span className="sr-only"> ({prov})</span>
    </span>
  );
}

/** Click/tap/keyboard-friendly provenance popover for headline numbers. */
export function Provenance({ p, tz, note }: { p: Provenanced<unknown>; tz: string; note?: string }) {
  return (
    <details className="prov">
      <summary aria-label="Show source, retrieval time and status">
        <span aria-hidden="true">i</span>
      </summary>
      <p>{provenanceText(p, tz, note)}</p>
    </details>
  );
}
