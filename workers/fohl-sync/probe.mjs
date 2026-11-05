import { fileURLToPath, pathToFileURL } from 'node:url';

const wranglerEntry = process.argv[2];
const { getPlatformProxy } = await import(wranglerEntry ? pathToFileURL(wranglerEntry).href : 'wrangler');

const proxy = await getPlatformProxy({
    configPath: fileURLToPath(new URL('./probe.wrangler.json', import.meta.url)),
    persist: false,
    remoteBindings: true,
});
try {
    const postId = process.argv[3];
    const result = JSON.parse(JSON.stringify(await (postId ? proxy.env.SYNC.inspectPost(postId) : proxy.env.SYNC.inspect())));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
} finally {
    await proxy.dispose();
}
