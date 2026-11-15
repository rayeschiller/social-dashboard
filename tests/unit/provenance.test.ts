import { describe, expect, it } from "vitest";
import {
  available,
  formatMetric,
  formatSigned,
  isAvailable,
  notAvailable,
  UNAVAILABLE_LABEL,
  type Provenanced,
} from "../../src/lib/provenance";

const at = new Date("2026-11-15T12:00:00Z");

describe("provenance formatting", () => {
  it('renders a real 0 as "0", never as Unavailable', () => {
    expect(formatMetric(available(0, "instagram_graph_api", at))).toBe("0");
  });

  it.each(["unavailable", "unsupported", "error", "pending"] as const)('renders status %s as "Unavailable"', (status) => {
    const p: Provenanced<number> = notAvailable(status, "synthetic reason");
    expect(formatMetric(p)).toBe("Unavailable");
    expect(UNAVAILABLE_LABEL).toBe("Unavailable");
  });

  it("formats integers with separators and keeps decimals", () => {
    expect(formatMetric(available(12345, "instagram_graph_api", at))).toBe("12,345");
    expect(formatMetric(available(2.5, "derived_from_snapshots", at))).toBe("2.5");
  });

  it("uses a custom formatter only for available values", () => {
    const fmt = (v: { delta: number }) => formatSigned(v.delta);
    expect(formatMetric(available({ delta: 7 }, "derived_from_snapshots", at), fmt)).toBe("+7");
    expect(formatMetric(available({ delta: -3 }, "derived_from_snapshots", at), fmt)).toBe("-3");
    expect(formatMetric(available({ delta: 0 }, "derived_from_snapshots", at), fmt)).toBe("0");
    expect(formatMetric(notAvailable("unavailable", "no baseline") as Provenanced<{ delta: number }>, fmt)).toBe("Unavailable");
  });

  it("non-available results carry no value field", () => {
    const p = notAvailable("unsupported", "Reels follows not provided by the API");
    expect("value" in p).toBe(false);
    expect(isAvailable(p)).toBe(false);
  });
});
