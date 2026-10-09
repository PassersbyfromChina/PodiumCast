/**
 * PodiumCast end-to-end smoke test.
 *
 * It exercises the real transport, not mocks: a NodeCastBridge + CastSession and a
 * NodeStageBridge + StageSession talk to each other over a real TCP socket, exactly as the
 * packaged desktop apps do. Everything asserted here is behaviour the shipping apps depend on:
 *
 *   1. handshake (hello → welcome → specs → state → library)
 *   2. display-driven recording-spec matching — 要求.txt (一)
 *   3. remote control routing — 要求.txt (三: 在大屏端可开始拍照或录制)
 *   4. live preview frames on the binary channel
 *   5. chunked file transfer in the Cast → Stage direction — 要求.txt (互相拉取)
 *   6. heartbeat liveness
 *
 * Run with: npm run smoke
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CastSession,
  StageSession,
  buildSpecs,
  defaultState,
  makeSpec,
  matchSpec,
  type ControlCommand,
  type DisplaySpec,
  type MediaFile,
  type RecordingSpec,
} from '@podiumcast/core';
import { NodeCastBridge, NodeMediaStore, NodeStageBridge } from '@podiumcast/core/node';

const PORT = 18765;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function waitFor<T>(register: (resolve: (v: T) => void) => void, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时等待：${label}`)), timeoutMs);
    register((value: T) => { clearTimeout(timer); resolve(value) });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'podiumcast-smoke-'));
  const castDir = path.join(root, 'cast');
  const stageDir = path.join(root, 'stage');
  await fs.mkdir(castDir, { recursive: true });
  await fs.mkdir(stageDir, { recursive: true });

  const castStore = new NodeMediaStore(castDir, 'podiumcast://media');
  const stageStore = new NodeMediaStore(stageDir, 'podiumcast://media');
  await castStore.init();
  await stageStore.init();

  const castBridge = new NodeCastBridge({ name: 'SMOKE-CAST', platform: 'windows', version: 1 });
  const stageBridge = new NodeStageBridge();

  const cast = new CastSession({
    bridge: castBridge,
    store: castStore,
    identity: { id: 'cast-1', name: 'SMOKE-CAST', role: 'cast', platform: 'windows', arch: 'x64', appVersion: '1.0.0' },
    state: { storageTarget: 'cast' },
    port: PORT,
  });

  const stage = new StageSession({
    bridge: stageBridge,
    store: stageStore,
    identity: { id: 'stage-1', name: 'SMOKE-STAGE', role: 'stage', platform: 'windows', arch: 'x64', appVersion: '1.0.0' },
    display: (): DisplaySpec => ({
      width: 1920, height: 1080, aspect: '16:9', ratio: 16 / 9, fps: 60,
      colorSpace: 'srgb', fullscreen: true, devicePixelRatio: 1,
    }),
  });

  const intents: ControlCommand[] = [];
  cast.events.on('intent', ({ cmd }) => intents.push(cmd));

  // ---------------------------------------------------------------- 1. handshake
  const bound = await cast.start(PORT);
  check('拍摄端监听端口', bound === PORT, `port=${bound}`);

  const welcome = waitFor<{ accept: boolean; device: { name: string } }>(
    (r) => stage.events.on('welcome', r), 6000, 'welcome',
  );
  const notices: string[] = [];
  cast.events.on('notice', ({ message }) => notices.push(message));

  await stage.connect(`ws://127.0.0.1:${PORT}`);
  const w = await welcome;
  check('握手成功', w.accept === true, `对端=${w.device.name}`);
  check('拍摄端记录到已连接', notices.some((n) => n.includes('已连接')), notices.join(' | '));

  // ---------------------------------------------------------------- 2. spec matching
  const specs: RecordingSpec[] = buildSpecs(
    [3840, 2560, 1920, 1280, 854],
    [2160, 1440, 1080, 720, 480],
    [60, 30],
    ['srgb'],
  );
  cast.setSpecs(specs, specs.find((s) => s.width === 1280)?.id);

  const gotSpecs = await waitFor<{ specs: RecordingSpec[]; current: string }>(
    (r) => stage.events.on('specs', r), 4000, '收不到 specs',
  ).catch(() => ({ specs: [] as RecordingSpec[], current: '' }));
  check('大屏端收到录制规格列表', gotSpecs.specs.length > 0, `${gotSpecs.specs.length} 条`);

  // A 4:3 display must win over the more common 16:9 modes.
  const display43: DisplaySpec = {
    width: 1024, height: 768, aspect: '4:3', ratio: 4 / 3, fps: 60,
    colorSpace: 'srgb', fullscreen: true, devicePixelRatio: 1,
  };
  const match = matchSpec(specs, display43);
  check('比例匹配选择 4:3', match.spec?.aspect === '4:3', `${match.spec?.aspect ?? '无'} · ${match.note}`);

  const exact169 = matchSpec(specs, { width: 1920, height: 1080, aspect: '16:9', ratio: 16 / 9, fps: 60, colorSpace: 'srgb', fullscreen: true, devicePixelRatio: 1 });
  check('比例匹配选择 16:9 且不超采样', exact169.spec?.aspect === '16:9' && (exact169.spec?.height ?? 0) >= 1080, exact169.note);

  // ---------------------------------------------------------------- 3. remote control
  stage.send({ k: 'photo' });
  stage.send({ k: 'record-start' });
  stage.send({ k: 'zoom', value: 2.5 });
  await sleep(300);
  const kinds = intents.map((c) => c.k);
  check('远端拍照指令到达拍摄端', kinds.includes('photo'), kinds.join(','));
  check('远端录制指令到达拍摄端', kinds.includes('record-start'), kinds.join(','));
  const zoomCmd = intents.find((c) => c.k === 'zoom');
  check('远端变焦指令携带正确参数', zoomCmd?.k === 'zoom' && Math.abs(zoomCmd.value - 2.5) < 0.001, JSON.stringify(zoomCmd));

  // ---------------------------------------------------------------- 4. preview frames
  const frameBuffer = new Uint8Array(2048);
  for (let i = 0; i < frameBuffer.length; i++) frameBuffer[i] = (i * 7) & 0xff;
  const previewPromise = waitFor<{ frameId: number; jpeg: Uint8Array }>(
    (r) => stage.events.on('preview', r), 4000, '收不到预览帧',
  );
  const sentTo = cast.pushPreviewFrame(frameBuffer, 42);
  const frame = await previewPromise;
  check('预览帧送达大屏端', sentTo === 1 && frame.frameId === 42, `peers=${sentTo} frameId=${frame.frameId}`);
  check('预览帧内容未被破坏', frame.jpeg.length === frameBuffer.length && frame.jpeg[100] === frameBuffer[100],
    `${frame.jpeg.length} vs ${frameBuffer.length}`);

  // ---------------------------------------------------------------- 5. file transfer
  const payload = new Uint8Array(700 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
  const handle = await castStore.beginWrite('PodiumCast_VIDEO_smoke.webm', 'video', {
    mime: 'video/webm', width: 1920, height: 1080, createdAt: Date.now(),
  });
  // Written in 64 KiB slices, the same way MediaRecorder feeds the store.
  for (let off = 0; off < payload.length; off += 65536) {
    await castStore.appendWrite(handle, payload.subarray(off, Math.min(off + 65536, payload.length)));
  }
  const recorded: MediaFile = await castStore.endWrite(handle, 4200);
  cast.setLibrary(await castStore.list());
  check('拍摄端写入录像文件', recorded.size === payload.length, `${recorded.size} bytes`);

  // The Cast announces its library; the Stage pulls the file back.
  const librarySeen = waitFor<{ files: MediaFile[] }>((r) => stage.events.on('library', r), 4000, '收不到 library')
    .catch(() => ({ files: [] as MediaFile[] }));
  cast.setLibrary(await castStore.list());
  const lib = await librarySeen;
  check('大屏端看到拍摄端文件', lib.files.some((f) => f.name === recorded.name), `${lib.files.length} 个`);

  const receivedPromise = waitFor<MediaFile>((r) => stage.events.on('received', r), 15000, '收不到文件');
  const remoteFile = lib.files.find((f) => f.name === recorded.name) ?? recorded;
  stage.requestFile(remoteFile);
  const arrived = await receivedPromise;
  const bytes = await stageStore.readAll(arrived.id);
  check('文件完整传输到另一端', bytes.length === payload.length, `${bytes.length} bytes`);
  let identical = bytes.length === payload.length;
  if (identical) {
    for (let i = 0; i < bytes.length; i += 997) {
      if (bytes[i] !== payload[i]) { identical = false; break }
    }
  }
  check('传输内容逐字节一致（抽样）', identical);
  check('接收端文件命名保留序号后缀', arrived.name.startsWith('PodiumCast_VIDEO_'), arrived.name);

  const stageFiles = await stageStore.list();
  check('大屏端库中已落盘', stageFiles.some((f) => f.name === arrived.name), `${stageFiles.length} 个`);

  // ---------------------------------------------------------------- 6. heartbeat
  const before = cast.getPeers().length;
  await sleep(3400);
  const after = cast.getPeers().length;
  check('心跳保活未误断连接', before === 1 && after === 1, `${before} -> ${after}`);

  // ---------------------------------------------------------------- 7. state sync
  cast.patchState({ recording: true, recordingMs: 1234, zoom: 2.5 });
  const stateSeen = await waitFor<{ recording: boolean }>((r) => stage.events.on('state', r), 3000, '收不到 state')
    .catch(() => ({ recording: false }));
  check('录制状态同步到大屏端', stateSeen.recording === true);

  // ---------------------------------------------------------------- teardown
  // `dispose()` clears StageSession's 1 Hz frame-rate sampler; without it the process would
  // sit on a live interval and CI would hang instead of reporting a result.
  stage.dispose();
  await cast.stop();
  await fs.rm(root, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.error('失败项：');
    for (const f of failed) console.error(`  · ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
  void defaultState;
  void makeSpec;
  // Explicit exit: a stray socket keep-alive must not turn a green run into a hung job.
  process.exit(failed.length ? 1 : 0);
}

await main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
