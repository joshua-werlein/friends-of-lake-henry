// Reuse the locked Astro toolchain; no additional test framework or major dependency changes.
import { readFile, access } from 'node:fs/promises';
import { transform } from 'esbuild';
export async function resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        try { await access(candidate); return { url: candidate.href, shortCircuit: true }; }
        catch { /* Let Node resolve ordinary imports. */ }
    }
    return next(specifier, context);
}
export async function load(url, context, next) {
    if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
        const { code } = await transform(await readFile(new URL(url), 'utf8'), { loader: 'ts', format: 'esm' });
        return { format: 'module', source: code, shortCircuit: true };
    }
    return next(url, context);
}
