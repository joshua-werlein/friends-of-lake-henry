import type {Env} from './poller';
/** The retired tagged-video verifier cannot authorize or stage the new livestream policy. */
export async function verifyAndStage(_env:Env,_expectedId:string,_deps:unknown={}) {
    return {ok:false,status:'legacy-verification-retired',detail:'Use the strict Page Live edge verification and a new reviewed policy receipt.'};
}
