import { runBybitLiveManagerSmoke } from './bybit-live-manager-smoke.mts';

const artifact = await runBybitLiveManagerSmoke();
console.log(JSON.stringify(artifact, null, 2));
if (artifact.status !== 'read-only-live-observation') process.exitCode = 2;
