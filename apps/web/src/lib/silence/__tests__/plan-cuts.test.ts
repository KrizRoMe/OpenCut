import { describe, expect, test } from "bun:test";
import { planAutoTrim } from "@/lib/silence/plan-cuts";
import { resolveAutoTrimConfig } from "@/lib/silence/config";
import type { CutRange } from "@/lib/silence/types";

const cut = (from: number, to: number): CutRange => ({
	from,
	to,
	reason: "silence",
});

describe("planAutoTrim", () => {
	const config = resolveAutoTrimConfig();

	test("merges cuts closer than mergeGapMs", () => {
		const plan = planAutoTrim({
			cuts: [cut(0, 1), cut(1.05, 2)],
			spanStart: 0,
			spanEnd: 3,
			config,
		});
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0].from).toBeCloseTo(0, 5);
		expect(plan.cuts[0].to).toBeCloseTo(2, 5);
		expect(plan.removedSeconds).toBeCloseTo(2, 5);
	});

	test("does not merge cuts beyond mergeGapMs", () => {
		const plan = planAutoTrim({
			cuts: [cut(0, 1), cut(1.5, 2)],
			spanStart: 0,
			spanEnd: 3,
			config,
		});
		expect(plan.cuts).toHaveLength(2);
		expect(plan.removedSeconds).toBeCloseTo(1.5, 5);
	});

	test("clamps cuts to the clip span", () => {
		const plan = planAutoTrim({
			cuts: [cut(-1, 5)],
			spanStart: 0,
			spanEnd: 3,
			config,
		});
		expect(plan.cuts).toHaveLength(1);
		expect(plan.cuts[0].from).toBeCloseTo(0, 5);
		expect(plan.cuts[0].to).toBeCloseTo(3, 5);
	});

	test("drops slivers shorter than minCutMs", () => {
		const plan = planAutoTrim({
			cuts: [cut(0, 0.02)],
			spanStart: 0,
			spanEnd: 3,
			config,
		});
		expect(plan.cuts).toHaveLength(0);
		expect(plan.removedSeconds).toBe(0);
	});

	test("sorts unordered cuts", () => {
		const plan = planAutoTrim({
			cuts: [cut(2, 2.5), cut(0, 0.5)],
			spanStart: 0,
			spanEnd: 3,
			config,
		});
		expect(plan.cuts.map((c) => c.from)).toEqual([0, 2]);
	});
});
