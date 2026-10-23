// Q07 drives the public store API, not a browser or the source stores. The
// server fixture remains alive; our writer has its own namespace in that home.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createIssuesStore } from "../../src/issues-store.mjs";
import { sha256Hex } from "../../src/issues-raster.mjs";
import { AT, owner, maintainer, capture, createBody, commandBody, terminateAtBarrier } from "../../test/fixtures/issues-crash-worker.mjs";
import { withDeadline } from "../issues-fixture.mjs";
import { deriveUuids } from "./fixture-data.mjs";

function snapshot(home, roots) {
	const result = {};
	for (const relative of roots) {
		const base = path.join(home, relative);
		result[relative] = {};
		if (!fs.existsSync(base)) continue;
		for (const name of fs.readdirSync(base, { recursive: true })) {
			const file = path.join(base, name);
			if (fs.statSync(file).isFile()) result[relative][name.replaceAll("\\", "/")] = sha256Hex(fs.readFileSync(file));
		}
	}
	return result;
}

export default async function run({ ctx, check, evidence }) {
	const uuids = ctx.fixtures.uuids;
	const dataDir = path.join(ctx.home, "data", "q07");
	const sourceRoots = ["data/proposals", "data/threads", "mailbox"];
	const before = snapshot(ctx.home, sourceRoots);
	const journal = { operations: [], failures: [], hashes: {} };
	const crashes = [];
	let store = createIssuesStore({ dataDir, now: () => new Date(AT), uuid: () => uuids[0] });
	const create = createBody(store.storeId, uuids[1], capture(uuids[2]));
	let seq = 1;
	const prior = [];
	const bounded = (promise, label) => withDeadline(promise, 10_000, `q07_${label}`);
	function remember(result) {
		journal.operations.push(result);
		return result;
	}
	async function send(command, actor, expectedSeq = seq) {
		const body = commandBody(store.storeId, uuids[prior.length + 3], expectedSeq, command);
		const result = await bounded(store.command(create.requestId, body, actor), command.type);
		prior.push({ body, actor });
		seq = result.body.currentSeq;
		return remember(result);
	}
	try {
		remember(await bounded(store.create(create, owner), "create"));
		const captureRoot = `data/q07/issues/records/${create.requestId}/evidence/${create.evidence.captureId}`;
		journal.hashes.original = snapshot(ctx.home, [captureRoot]);
		await send({ type: "triage", category: "inbox-ui", severity: "high", note: "Investigated" }, maintainer);
		await send({
			type: "request_check", note: "Check the correction",
			correction: { kind: "inbox-build", buildId: owner.buildId, summary: "Correction build, separate from confirmation" },
			evidence: null,
		}, maintainer);
		await send({ type: "confirm" }, owner);
		await send({ type: "reopen", comment: "Still present" }, owner);
		check("Q07 lifecycle states are authoritative", JSON.stringify(journal.operations.map((r) => r.body.state)) === JSON.stringify(["open", "investigating", "needs-check", "resolved", "open"]));
		await send({ type: "append_evidence", evidence: capture(uuids[20]), note: "Later evidence" }, owner);
		journal.hashes.afterAppend = snapshot(ctx.home, [captureRoot]);
		check("Q07 original evidence hashes never change", JSON.stringify(journal.hashes.original) === JSON.stringify(journal.hashes.afterAppend));
		check("Q07 receipt sequence is contiguous", journal.operations.every((r, i) => r.body.receipt.seq === i + 1));
		const image = store.evidenceImage(create.requestId, create.evidence.captureId);
		check("Q07 manifest matches retained PNG bytes", image.sha256 === sha256Hex(image.bytes));

		const a = commandBody(store.storeId, uuids[21], seq, { type: "comment", text: "race-a" });
		const b = commandBody(store.storeId, uuids[22], seq, { type: "comment", text: "race-b" });
		const race = await bounded(Promise.allSettled([store.command(create.requestId, a, owner), store.command(create.requestId, b, owner)]), "cas");
		journal.race = race.map((entry) => entry.status === "fulfilled" ? entry.value : { error: entry.reason.code, currentSeq: entry.reason.currentSeq });
		check("Q07 two competing commands commit one effect", race.filter((r) => r.status === "fulfilled").length === 1 && race.find((r) => r.status === "rejected")?.reason.code === "version_conflict");
		const winner = race[0].status === "fulfilled" ? a : b;
		prior.push({ body: winner, actor: owner });
		seq++;
		try {
			await store.command(create.requestId, { ...winner, command: { type: "comment", text: "changed body" } }, owner);
			check("Q07 changed body under one key conflicts", false);
		} catch (error) {
			journal.failures.push({ operation: "key-reuse", code: error.code });
			check("Q07 changed body under one key conflicts", error.code === "key_reused");
		}
		store.close();
		store = createIssuesStore({ dataDir, now: () => new Date(AT) });
		const replay = await bounded(store.command(create.requestId, winner, owner), "restart_replay");
		journal.replay = replay;
		check("Q07 restart replay returns original receipt without another event", replay.replayed && replay.body.receipt.seq === seq && replay.body.currentSeq === seq && replay.event === null);

		for (const fault of ["ENOSPC", "EIO"]) {
			const command = commandBody(store.storeId, uuids[fault === "ENOSPC" ? 23 : 24], seq, { type: "append_evidence", evidence: capture(uuids[25]), note: null });
			const method = fault === "ENOSPC" ? "writeFileSync" : "renameSync";
			const real = fs[method];
			let observed = null;
			fs[method] = function(...args) {
				const file = String(args[fault === "ENOSPC" ? 0 : 1]).replaceAll("\\", "/");
				if (fault === "ENOSPC" ? file.endsWith("image.png") : /\/events\/\d+\.json$/.test(file)) {
					throw Object.assign(new Error(`Q07 injected ${fault}`), { code: fault });
				}
				return real.apply(this, args);
			};
			try { await bounded(store.command(create.requestId, command, owner), `fault_${fault}`); } catch (error) { observed = error.code; }
			finally { fs[method] = real; }
			journal.failures.push({ operation: fault, code: observed, currentSeq: store.get(create.requestId).currentSeq });
			check(`Q07 ${fault} has no accepted partial event`, observed === fault && store.get(create.requestId).currentSeq === seq && store.get(create.requestId).evidence.length === 2);
		}
		journal.beforePurge = store.get(create.requestId);
		const purge = commandBody(store.storeId, uuids[26], seq, { type: "purge" });
		remember(await bounded(store.command(create.requestId, purge, owner), "purge"));
		prior.push({ body: purge, actor: owner });
		store.close();
		store = createIssuesStore({ dataDir, now: () => new Date(AT) });
		const gone = [];
		try { await store.create(create, owner); } catch (error) { gone.push(error.code); }
		for (const request of prior) {
			try { await store.command(create.requestId, request.body, request.actor); } catch (error) { gone.push(error.code); }
		}
		journal.purgeReplay = gone;
		check("Q07 every prior accepted key is gone after purge", gone.length === prior.length + 1 && gone.every((entry) => entry === "gone"));
		check("Q07 purged record content is physically absent", !fs.existsSync(path.join(dataDir, "issues", "records", create.requestId)));

		const pageIds = deriveUuids(uuids[27], 201);
		const paginated = createBody(store.storeId, uuids[28], capture(pageIds[0], false));
		await bounded(store.create(paginated, owner), "pagination_create");
		for (let seq = 2; seq <= 101; seq++) {
			const body = commandBody(store.storeId, pageIds[seq * 2 - 3], seq - 1, {
				type: "append_evidence", evidence: capture(pageIds[seq * 2 - 2], false), note: null,
			});
			await bounded(store.command(paginated.requestId, body, owner), `pagination_append_${seq}`);
		}
		store.close();
		store = createIssuesStore({ dataDir, now: () => new Date(AT) });
		const first = store.get(paginated.requestId);
		const maximum = store.get(paginated.requestId, { limit: 100 });
		const last = store.get(paginated.requestId, { after: 100 });
		const pages = [];
		let after = 0;
		do {
			const page = store.get(paginated.requestId, { after });
			pages.push({
				after, nextAfter: page.nextAfter, events: page.events.map((event) => event.seq),
				evidence: page.evidence.map(({ seq, captureId }) => ({ seq, captureId })),
			});
			after = page.nextAfter;
		} while (after !== null);
		journal.pagination = {
			default: { events: first.events.length, manifests: first.evidence.length, nextAfter: first.nextAfter },
			maximum: { events: maximum.events.length, manifests: maximum.evidence.length, nextAfter: maximum.nextAfter },
			last: { events: last.events.length, manifests: last.evidence.length, nextAfter: last.nextAfter },
			pages,
		};
		check("Q07 101 evidence sets default to 50 events and manifests", first.events.length === 50 && first.evidence.length === 50 && first.nextAfter === 50);
		check("Q07 maximum page contains 100 events and manifests", maximum.events.length === 100 && maximum.evidence.length === 100 && maximum.nextAfter === 100);
		check("Q07 after 100 returns only the last event and manifest", last.events.length === 1 && last.events[0].seq === 101 && last.evidence.length === 1 && last.evidence[0].seq === 101 && last.nextAfter === null);
		const walked = pages.flatMap((page) => page.evidence.map((manifest) => manifest.captureId));
		check("Q07 nextAfter walks every evidence set exactly once", JSON.stringify(walked) === JSON.stringify(pageIds.filter((_, i) => i % 2 === 0)) &&
			pages.every((page) => page.events.length <= 50 && JSON.stringify(page.events) === JSON.stringify(page.evidence.map((manifest) => manifest.seq))));

		for (const operation of ["create", "append"]) {
			const points = operation === "create" ? ["after_evidence_staging", "after_record_rename", "before_response"]
				: ["after_evidence_staging", "after_evidence_publish", "after_event_rename", "before_response"];
			for (const point of points) {
				const crashDir = path.join(dataDir, "crashes", `${operation}-${point}`);
				let crashed = createIssuesStore({ dataDir: crashDir, now: () => new Date(AT) });
				try {
					const body = createBody(crashed.storeId, uuids[1], capture(uuids[2]));
					if (operation === "append") await bounded(crashed.create(body, owner), `seed_${point}`);
					const request = operation === "create" ? body
						: commandBody(crashed.storeId, uuids[3], 1, { type: "append_evidence", evidence: capture(uuids[4]), note: null });
					crashed.close();
					const transcript = await terminateAtBarrier({ dataDir: crashDir, body: request, id: operation === "append" ? body.requestId : undefined, point });
					crashed = createIssuesStore({ dataDir: crashDir, now: () => new Date(AT) });
					const replayed = operation === "create" ? await bounded(crashed.create(request, owner), `replay_${point}`)
						: await bounded(crashed.command(body.requestId, request, owner), `replay_${point}`);
					const committed = ["after_record_rename", "after_event_rename", "before_response"].includes(point);
					const detail = crashed.get(body.requestId);
					for (const manifest of detail.evidence) assert.equal(crashed.evidenceImage(body.requestId, manifest.captureId).sha256, manifest.visual.sha256);
					crashes.push({ operation, ...transcript, replayed, sequences: detail.events.map((event) => event.seq) });
					check(`Q07 real termination ${operation}/${point} replays exactly once`, replayed.replayed === committed && detail.currentSeq === (operation === "create" ? 1 : 2));
				} finally {
					crashed.close();
				}
			}
		}
	} finally {
		store.close();
		const after = snapshot(ctx.home, sourceRoots);
		const isolated = JSON.stringify(before) === JSON.stringify(after);
		check("Q07 proposal, thread and mailbox files are unchanged", isolated);
		evidence("Q07-journal.json", JSON.stringify(journal, null, "\t"));
		evidence("Q07-crash-transcript.txt", crashes.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		evidence("Q07-isolation.json", JSON.stringify({ before, after, identical: isolated }, null, "\t"));
	}
}
