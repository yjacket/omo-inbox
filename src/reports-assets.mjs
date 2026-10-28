// Immutable report pictures on a dedicated assets branch. The branch is
// created once with an empty commit; a picture is written only when the path
// does not exist yet, and an existing path must hold the same bytes.

import { createHash } from "node:crypto";
import { GitHubError } from "./github-api.mjs";

const BOOTSTRAP_MESSAGE = "Initialize inbox report assets";
const EMPTY_TREE = {
	tree: [{ path: ".gitkeep", mode: "100644", type: "blob", content: "" }],
};
const ensured = new WeakMap();

export function gitBlobSha(buf) {
	return createHash("sha1")
		.update(`blob ${buf.length}\0`)
		.update(buf)
		.digest("hex");
}

export function assetPath(record) {
	const created = new Date(record.createdAt);
	if (Number.isNaN(created.getTime())) throw new Error("invalid createdAt");
	const year = String(created.getUTCFullYear()).padStart(4, "0");
	const month = String(created.getUTCMonth() + 1).padStart(2, "0");
	return `reports/${year}/${month}/${record.id}.png`;
}

function contentPath(api, path) {
	const segments = String(path).split("/").map(encodeURIComponent);
	return `/repos/${api.repo}/contents/${segments.join("/")}`;
}

function refPath(api, branch) {
	return `/repos/${api.repo}/git/ref/heads/${encodeURIComponent(branch)}`;
}

function conflict() {
	return new GitHubError("validation", {
		codes: ["attachment_conflict"],
		message: "asset already exists with different bytes",
	});
}

function unexpected(method, path, response) {
	return new Error(`${method} ${path} failed with ${response.status}`);
}

function branchKnown(api, branch) {
	const branches = ensured.get(api);
	return branches != null && branches.has(branch);
}

function rememberBranch(api, branch) {
	let branches = ensured.get(api);
	if (branches == null) {
		branches = new Set();
		ensured.set(api, branches);
	}
	branches.add(branch);
}

export async function ensureAssetsBranch(api, { branch }) {
	if (branchKnown(api, branch)) return;
	const getRef = () => api.request("GET", refPath(api, branch), { allow: [404] });

	const existing = await getRef();
	if (existing.status === 200) {
		rememberBranch(api, branch);
		return;
	}
	if (existing.status !== 404) throw unexpected("GET", refPath(api, branch), existing);

	// The ref lookup answers 404 for a missing repository too, so prove the
	// repository exists before writing anything.
	await api.repoInfo();

	const trees = await api.request("POST", `/repos/${api.repo}/git/trees`, { body: EMPTY_TREE });
	if (trees.status !== 201 && trees.status !== 200) {
		throw unexpected("POST", `/repos/${api.repo}/git/trees`, trees);
	}
	const commit = await api.request("POST", `/repos/${api.repo}/git/commits`, {
		body: { message: BOOTSTRAP_MESSAGE, tree: trees.json.tree.sha, parents: [] },
	});
	if (commit.status !== 201 && commit.status !== 200) {
		throw unexpected("POST", `/repos/${api.repo}/git/commits`, commit);
	}
	const refs = await api.request("POST", `/repos/${api.repo}/git/refs`, {
		body: { ref: `refs/heads/${branch}`, sha: commit.json.sha },
		allow: [422],
	});
	if (refs.status === 422) {
		const raced = await getRef();
		if (raced.status !== 200) {
			throw new GitHubError("validation", {
				status: 422,
				message: "assets branch could not be created",
			});
		}
	} else if (refs.status !== 201 && refs.status !== 200) {
		throw unexpected("POST", `/repos/${api.repo}/git/refs`, refs);
	}
	rememberBranch(api, branch);
}

function compareExisting(existing, path, bytes) {
	const sha = existing.json?.sha;
	if (typeof sha !== "string") {
		throw new GitHubError("validation", { status: existing.status, message: "asset response has no sha" });
	}
	if (sha !== gitBlobSha(bytes)) throw conflict();
	return { path, blobSha: sha };
}

export async function putAsset(api, { branch, path, bytes, message }) {
	const target = contentPath(api, path);
	const get = () => api.request("GET", target, { query: { ref: branch }, allow: [404] });

	const existing = await get();
	if (existing.status === 200) return compareExisting(existing, path, bytes);
	if (existing.status !== 404) throw unexpected("GET", target, existing);

	const put = await api.request("PUT", target, {
		body: { message, content: bytes.toString("base64"), branch },
		allow: [422],
	});
	if (put.status === 422) {
		// A concurrent upload may have won the race; repeat the comparison once.
		const again = await get();
		if (again.status === 200) return compareExisting(again, path, bytes);
		throw new GitHubError("validation", { status: 422, message: "asset could not be written" });
	}
	if (put.status !== 200 && put.status !== 201) throw unexpected("PUT", target, put);
	const sha = put.json?.content?.sha;
	if (typeof sha !== "string") {
		throw new GitHubError("validation", { status: put.status, message: "asset response has no sha" });
	}
	return { path, blobSha: sha };
}
