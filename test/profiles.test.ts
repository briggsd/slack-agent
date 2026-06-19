import { describe, it, expect } from 'vitest';
import {
  PROFILES,
  DEFAULT_PROFILE_ID,
  SUPERVISED_REPO_ONESHOT_PROFILE_ID,
  getProfile,
} from '../src/profiles/registry.js';
import type { Profile } from '../src/profiles/registry.js';

describe('profiles registry', () => {
  it('exports DEFAULT_PROFILE_ID as "conversational"', () => {
    expect(DEFAULT_PROFILE_ID).toBe('conversational');
  });

  it('exports SUPERVISED_REPO_ONESHOT_PROFILE_ID as "supervised-repo-oneshot"', () => {
    expect(SUPERVISED_REPO_ONESHOT_PROFILE_ID).toBe('supervised-repo-oneshot');
  });

  it('PROFILES contains the conversational entry with planGate: false', () => {
    const p = PROFILES.get('conversational');
    expect(p).toBeDefined();
    expect(p?.id).toBe('conversational');
    expect(p?.label).toBe('Conversational');
    expect(p?.mode).toBe('conversational');
    expect(p?.planGate).toBe(false);
  });

  it('PROFILES contains the repo-oneshot entry with mode one-shot and planGate: false', () => {
    const p = PROFILES.get('repo-oneshot');
    expect(p).toBeDefined();
    expect(p?.id).toBe('repo-oneshot');
    expect(p?.label).toBe('Repo (one-shot)');
    expect(p?.mode).toBe('one-shot');
    expect(p?.planGate).toBe(false);
  });

  it('PROFILES contains the supervised-repo-oneshot entry with planGate: true', () => {
    const p = PROFILES.get('supervised-repo-oneshot');
    expect(p).toBeDefined();
    expect(p?.id).toBe('supervised-repo-oneshot');
    expect(p?.label).toBe('Repo (supervised one-shot)');
    expect(p?.mode).toBe('one-shot');
    expect(p?.planGate).toBe(true);
  });

  it('getProfile resolves a known id', () => {
    const p: Profile = getProfile('conversational');
    expect(p.id).toBe('conversational');
    expect(p.label).toBe('Conversational');
    expect(p.mode).toBe('conversational');
    expect(p.planGate).toBe(false);
  });

  it('getProfile resolves supervised-repo-oneshot', () => {
    const p: Profile = getProfile('supervised-repo-oneshot');
    expect(p.id).toBe('supervised-repo-oneshot');
    expect(p.label).toBe('Repo (supervised one-shot)');
    expect(p.mode).toBe('one-shot');
    expect(p.planGate).toBe(true);
  });

  it('getProfile falls back to the default for an unknown id', () => {
    const p: Profile = getProfile('totally-unknown-id');
    expect(p.id).toBe(DEFAULT_PROFILE_ID);
  });

  it('getProfile(DEFAULT_PROFILE_ID) returns the same object as the registry', () => {
    const fromRegistry = PROFILES.get(DEFAULT_PROFILE_ID);
    const fromGetter = getProfile(DEFAULT_PROFILE_ID);
    expect(fromGetter).toBe(fromRegistry);
  });
});

describe('conversational profile flows to factory.create', () => {
  it('FakeRunnerFactory records the profile passed to create()', async () => {
    const { FakeRunnerFactory } = await import('../src/runner/fake.js');
    const factory = new FakeRunnerFactory();
    const profile: Profile = { id: 'conversational', label: 'Conversational', mode: 'conversational', planGate: false };
    await factory.create('TEAM:C:T', profile);
    expect(factory.profiles).toHaveLength(1);
    expect(factory.profiles[0]).toEqual(profile);
  });

  it('SessionManager passes the conversational profile to factory.create on enqueueNew', async () => {
    const { FakeRunnerFactory } = await import('../src/runner/fake.js');
    const { FakeSlackClient } = await import('./responder.test.js');
    const { SessionManager } = await import('../src/sessions/manager.js');

    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hi',
      channel: 'C',
      threadTs: 'T',
      profileId: 'conversational',
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(factory.profiles).toHaveLength(1);
    expect(factory.profiles[0]?.id).toBe('conversational');
  });

  it('SessionManager defaults to conversational when profileId is absent', async () => {
    const { FakeRunnerFactory } = await import('../src/runner/fake.js');
    const { FakeSlackClient } = await import('./responder.test.js');
    const { SessionManager } = await import('../src/sessions/manager.js');

    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hi',
      channel: 'C',
      threadTs: 'T',
      // profileId intentionally omitted
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(factory.profiles).toHaveLength(1);
    expect(factory.profiles[0]?.id).toBe('conversational');
  });
});
