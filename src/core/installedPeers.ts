/**
 * Peer-range checks between a project's **installed direct dependencies**, read straight from
 * `node_modules/<name>/package.json`.
 *
 * Why the install exit code isn't enough: npm keeps an already-locked tree without re-checking
 * the peers of packages it didn't touch, so bumping `react` to 19.3.0 installs fine while
 * `@react-three/fiber@9.7.0` still demands `react <19.3` — and the next clean install fails with
 * ERESOLVE. bun never enforces peers at all. Yarn Plug'n'Play has no `node_modules`, so nothing is
 * checked there.
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import type { ClassifiedConflict } from './conflictAnalyzer.js';

/** An installed direct dependency outside another direct dependency's peer range. */
export interface PeerViolation {
  /** The direct dependency declaring the peer, e.g. `@react-three/fiber`. */
  dependent: string;
  dependentVersion: string;
  /** The peer it declares, e.g. `react`. */
  peer: string;
  range: string;
  /** Installed version of `peer`. */
  installed: string;
}

interface InstalledManifest {
  version: string;
  /** Non-optional peer ranges. */
  peers: Map<string, string>;
}

async function readInstalled(roots: string[], name: string): Promise<InstalledManifest | undefined> {
  for (const root of roots) {
    let pkg: Record<string, unknown>;
    try {
      pkg = (await fs.readJson(path.join(root, 'node_modules', name, 'package.json'))) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof pkg.version !== 'string') {
      continue;
    }
    const declared = (pkg.peerDependencies ?? {}) as Record<string, unknown>;
    const meta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean } | undefined>;
    const peers = new Map<string, string>();
    for (const [peer, range] of Object.entries(declared)) {
      if (typeof range === 'string' && semver.validRange(range) && meta[peer]?.optional !== true) {
        peers.set(peer, range);
      }
    }
    return { version: pkg.version, peers };
  }
  return undefined;
}

async function readAllInstalled(
  names: Iterable<string>,
  roots: string[],
): Promise<Map<string, InstalledManifest>> {
  const manifests = new Map<string, InstalledManifest>();
  for (const name of new Set(names)) {
    const manifest = await readInstalled(roots, name);
    if (manifest) {
      manifests.set(name, manifest);
    }
  }
  return manifests;
}

/**
 * Every peer range one installed direct dependency places on another that the installed version
 * doesn't satisfy. `roots` are the directories whose `node_modules` hold the deps, nearest first.
 */
export async function findDirectPeerViolations(
  directNames: Iterable<string>,
  roots: string[],
): Promise<PeerViolation[]> {
  const manifests = await readAllInstalled(directNames, roots);
  const violations: PeerViolation[] = [];
  for (const [dependent, manifest] of manifests) {
    for (const [peer, range] of manifest.peers) {
      const installed = manifests.get(peer)?.version;
      if (installed && !semver.satisfies(installed, range, { includePrerelease: true })) {
        violations.push({ dependent, dependentVersion: manifest.version, peer, range, installed });
      }
    }
  }
  return violations;
}

/**
 * Peer ranges that installed direct dependencies **outside** `members` place on each member. A
 * package already at latest never joins a linked batch, yet its peers still bound the batch.
 */
export async function peerRangesOn(
  members: ReadonlySet<string>,
  directNames: Iterable<string>,
  roots: string[],
): Promise<Map<string, string[]>> {
  const outside = [...new Set(directNames)].filter((name) => !members.has(name));
  const ranges = new Map<string, string[]>();
  for (const manifest of (await readAllInstalled(outside, roots)).values()) {
    for (const [peer, range] of manifest.peers) {
      if (members.has(peer)) {
        ranges.set(peer, [...(ranges.get(peer) ?? []), range]);
      }
    }
  }
  return ranges;
}

/** Identity of a violation across installs (versions left out on purpose). */
export function peerViolationKey(v: PeerViolation): string {
  return `${v.dependent}>${v.peer}`;
}

export function describePeerViolation(v: PeerViolation): string {
  return `${v.peer}@${v.installed} is outside the peer range "${v.range}" of ${v.dependent}@${v.dependentVersion}`;
}

/** The shape the install-output parser produces, so the peer resolvers can act on it. */
export function peerViolationToConflict(v: PeerViolation): ClassifiedConflict {
  return {
    depender: `${v.dependent}@${v.dependentVersion}`,
    dependency: v.peer,
    requiredRange: v.range,
    installedVersion: v.installed,
    rawMessage: describePeerViolation(v),
    category: 'peerDependencyMismatch',
  };
}
