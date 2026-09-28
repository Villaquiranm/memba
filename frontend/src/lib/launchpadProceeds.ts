/** Chain-backed Launchpad native proceeds and directly signed claims. */
import { queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
export const PROCEEDS_CLAIM_GAS_WANTED = 50_000_000
const CLAIM_STORAGE_CAP = 1_000_000

function qInt(raw: string | null): bigint {
    const match = /^\((0|[1-9]\d*) int64\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify proceeds")
    return BigInt(match[1])
}

function qString(raw: string | null): string {
    const match = /^\(("(?:[^"\\]|\\.)*") string\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify proceeds")
    const value: unknown = JSON.parse(match[1])
    if (typeof value !== "string") throw new Error("Could not verify proceeds")
    return value
}

export interface NativeProceeds {
    configVersion: bigint
    treasury: string
    treasuryClaimable: bigint
    member: string | null
    memberClaimable: bigint | null
    totalLiability: bigint
}

async function claimable(rpcUrl: string, receiver: string): Promise<bigint> {
    if (!ADDRESS.test(receiver)) throw new Error("Invalid proceeds recipient")
    return qInt(await queryEval(rpcUrl, LAUNCHPAD_FEES_PATH,
        `ClaimableOfAddress("ugnot", ${JSON.stringify(receiver)})`, true))
}

export async function readNativeProceeds(rpcUrl: string, member: string | null): Promise<NativeProceeds> {
    if (member !== null && !ADDRESS.test(member)) throw new Error("Invalid connected wallet")
    const configVersion = qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true))
    if (configVersion < 1n) throw new Error("Launchpad policy is unavailable")
    const treasury = qString(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "CurrentTreasuryAddress()", true))
    if (!ADDRESS.test(treasury)) throw new Error("DAO treasury is unavailable")
    const treasuryRead = claimable(rpcUrl, treasury)
    const memberRead = member === null ? Promise.resolve(null) : member === treasury ? treasuryRead : claimable(rpcUrl, member)
    const [treasuryClaimable, memberClaimable, totalLiability, versionAfter] = await Promise.all([
        treasuryRead, memberRead,
        queryEval(rpcUrl, LAUNCHPAD_FEES_PATH, 'LiabilityOf("ugnot")', true).then(qInt),
        queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true).then(qInt),
    ])
    if (versionAfter !== configVersion || treasuryClaimable > totalLiability ||
        (memberClaimable !== null && memberClaimable > totalLiability) ||
        (member !== null && member !== treasury && memberClaimable !== null &&
            treasuryClaimable + memberClaimable > totalLiability)) throw new Error("Proceeds changed during read. Refresh.")
    return { configVersion, treasury, treasuryClaimable, member, memberClaimable, totalLiability }
}

export function proceedsClaimScope(chainId: string, caller: string): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_FEES_PATH, caller, operation: "claim:ugnot" }
}

export function buildProceedsClaimMsg(caller: string, amount: bigint): AminoMsg {
    if (!ADDRESS.test(caller) || amount < 1n) throw new Error("No native proceeds are ready to claim")
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_FEES_PATH,
        func: "Claim", args: ["ugnot"], max_deposit: `${CLAIM_STORAGE_CAP}ugnot` } }
}

export function claimNativeProceedsRequest(input: {
    caller: string; amount: bigint; rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number;
    onSettled?: () => void
}): SignRequest {
    const { caller, amount, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildProceedsClaimMsg(caller, amount)
    const scope = proceedsClaimScope(chainId, caller)
    const label = "Claim Launchpad proceeds"
    return {
        title: "Claim marketplace proceeds", summary: `${amount.toLocaleString()} ugnot goes to ${caller}`,
        lines: () => [["Claimed amount", `${amount.toLocaleString()} ugnot`], ["Receiver and signer", caller],
            ["Realm", LAUNCHPAD_FEES_PATH], ["Network", chainId],
            ["Gas limit", PROCEEDS_CLAIM_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${CLAIM_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The receiver must sign this transaction directly. DAO multisig proceeds require its own threshold signing process."],
        acks: ["I checked the receiver, amount and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            if (await claimable(rpcUrl, caller) !== amount) throw new Error("Claimable amount changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: PROCEEDS_CLAIM_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => await claimable(rpcUrl, caller) === 0n,
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}
