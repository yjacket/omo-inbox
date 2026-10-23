/* Q04: immutable capture context and capture-generation ownership.
 *
 * No browser: this scenario drives the pure module against the seeded decision Review and proves
 * that a frozen observation and a superseded asynchronous acquisition cannot follow live state.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function run({ ctx, check, evidence }) {
	const context = await import(pathToFileURL(path.join(ctx.appDir, "web", "issue-context.js")).href);
	const { freezeCapture: freeze, describeUnavailable: unavailable, createGenerationOwner: createOwner, attachLate: late, onDiscard: discard } = context;

	const decisionId = ctx.fixtures.decision.id;
	const captureId = ctx.fixtures.uuids[0];
	const now = () => 1729692896789;
	const live = {
		revision: 1,
		text: "rev1 text",
		view: {
			width: 390,
			height: 844,
			dpr: 1,
			scale: 1,
			scrollX: 0,
			scrollY: 0,
			theme: "light",
			locale: "ko-KR",
			embedded: false,
			viewerOpen: false,
		},
		target: {
			kind: "record",
			key: "review:decision",
			label: "제보 흐름 결정",
			rect: { x: 12, y: 24, w: 366, h: 180 },
			framePath: [],
		},
	};
	const captured = freeze({
		page: "proposal",
		source: {
			kind: "proposal",
			proposalId: decisionId,
			revision: live.revision,
			observedSeq: 1,
			recordedContentHash: null,
			frame: null,
		},
		target: live.target,
		view: live.view,
		excerpt: live.text,
		excerptEnabled: true,
		visibleIds: [],
		diagnostics: [],
		clientBuild: null,
		observedAt: "2026-10-23T12:34:56.789Z",
		uuid: () => captureId,
		now,
	});
	live.revision = 2;
	live.text = "rev2 text";
	live.view.width = 1;
	live.target.rect.w = 999;
	live.target.label = "changed";
	const serialized = JSON.stringify(captured);
	const after = JSON.parse(serialized);
	check("Q04 frozen capture keeps revision 1", after.source.revision === 1, String(after.source.revision));
	check("Q04 frozen capture keeps rev1 excerpt", after.excerpt === "rev1 text", String(after.excerpt));
	check("Q04 frozen nested view/target are deep copies", after.view.width === 390 && after.target.rect.w === 366 && after.target.label === "제보 흐름 결정", JSON.stringify({ view: after.view.width, rect: after.target.rect.w, label: after.target.label }));
	check("Q04 frozen capture is deeply frozen", Object.isFrozen(captured) && Object.isFrozen(captured.source) && Object.isFrozen(captured.target.rect) && Object.isFrozen(captured.view));
	check("Q04 live source moved to revision 2", live.revision === 2 && live.text === "rev2 text" && live.view.width === 1 && live.target.rect.w === 999);

	const owner = createOwner();
	const first = owner.begin();
	let firstCleanups = 0;
	discard(first, () => firstCleanups++);
	let resolveAcquisition;
	const acquisition = new Promise((resolve) => {
		resolveAcquisition = resolve;
	});
	const second = owner.begin();
	resolveAcquisition({ kind: "raster", bytes: 4 });
	const lateResult = await acquisition;
	const counts = { applied: 0, dropped: 0 };
	const outcome = late(first, owner, lateResult, () => counts.applied++, () => counts.dropped++);
	check("Q04 superseded acquisition is dropped once", outcome === "dropped" && counts.dropped === 1 && counts.applied === 0, JSON.stringify(counts));
	check("Q04 superseded generation cleanup ran once", firstCleanups === 1, String(firstCleanups));
	check("Q04 new generation still owns the capture", owner.isCurrent(second) && !owner.isCurrent(first));

	const cancelOwner = createOwner();
	const cancelled = cancelOwner.begin();
	let cancelCleanups = 0;
	discard(cancelled, () => cancelCleanups++);
	let resolveCancelled;
	const cancelledAcquisition = new Promise((resolve) => {
		resolveCancelled = resolve;
	});
	cancelOwner.cancel(cancelled);
	resolveCancelled({ kind: "raster", bytes: 8 });
	const cancelledCounts = { applied: 0, dropped: 0 };
	const cancelledOutcome = late(cancelled, cancelOwner, await cancelledAcquisition, () => cancelledCounts.applied++, () => cancelledCounts.dropped++);
	check("Q04 cancel then resolve drops once", cancelledOutcome === "dropped" && cancelledCounts.dropped === 1 && cancelledCounts.applied === 0, JSON.stringify(cancelledCounts));
	check("Q04 cancelled generation cleanup ran once", cancelCleanups === 1 && cancelOwner.current() === null, JSON.stringify({ cancelCleanups, current: cancelOwner.current() }));

	const noAdapter = unavailable("no_adapter", { uuid: () => captureId, now });
	check("Q04 no adapter is explicit unavailable", noAdapter.contextStatus === "unavailable");
	check("Q04 no adapter never invents latest data", noAdapter.source === null && noAdapter.excerpt === null && noAdapter.visibleIds.length === 0);

	evidence(
		"Q04-capture.json",
		JSON.stringify(
			{
				decisionId,
				before: { revision: captured.source.revision, excerpt: captured.excerpt, captured },
				after: { revision: after.source.revision, excerpt: after.excerpt, serialized },
				counts: { ...counts, firstCleanups, appliedToCurrentGeneration: 0, cancelledCounts, cancelCleanups },
				unavailable: noAdapter,
			},
			null,
			"\t",
		),
	);
}
