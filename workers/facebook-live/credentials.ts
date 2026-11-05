export type FacebookCredentials = {
    FB_CREDENTIAL_SET?: string;
    FB_PAGE_ACCESS_TOKEN?: string;
    FOHL_SYNC_PAGE_ACCESS_TOKEN?: string;
};

export function usesFohlSync(env: FacebookCredentials) {
    return env.FB_CREDENTIAL_SET === 'fohl-sync';
}

export function pageAccessToken(env: FacebookCredentials) {
    return usesFohlSync(env) ? env.FOHL_SYNC_PAGE_ACCESS_TOKEN : env.FB_PAGE_ACCESS_TOKEN;
}
