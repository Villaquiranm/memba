/** Chain-backed Launchpad native and WUGNOT proceeds with directly signed claims. */
import { queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { WUGNOT_KEY } from "./launchpadTokenTrade"
import { LAUNCHPAD_CONFIG_PATH, LAUNCHPAD_FEES_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
export const PROCEEDS_CLAIM_GAS_WANTED = 50_000_000
const CLAIM_STORAGE_CAP = 1_000_000
export type ProceedsCurrency = "ugnot" | typeof WUGNOT_KEY

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

async function claimable(rpcUrl: string, receiver: string, currency: ProceedsCurrency): Promise<bigint> {
    if (!ADDRESS.test(receiver)) throw new Error("Invalid proceeds recipient")
    return qInt(await queryEval(rpcUrl, LAUNCHPAD_FEES_PATH,
        `ClaimableOfAddress(${JSON.stringify(currency)}, ${JSON.stringify(receiver)})`, true))
}

export async function readCurrencyProceeds(rpcUrl: string, member: string | null, currency: ProceedsCurrency): Promise<NativeProceeds> {
    if (member !== null && !ADDRESS.test(member)) throw new Error("Invalid connected wallet")
    const configVersion = qInt(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true))
    if (configVersion < 1n) throw new Error("Launchpad policy is unavailable")
    const treasury = qString(await queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "CurrentTreasuryAddress()", true))
    if (!ADDRESS.test(treasury)) throw new Error("DAO treasury is unavailable")
    const treasuryRead = claimable(rpcUrl, treasury, currency)
    const memberRead = member === null ? Promise.resolve(null) : member === treasury ? treasuryRead : claimable(rpcUrl, member, currency)
    const [treasuryClaimable, memberClaimable, totalLiability, versionAfter] = await Promise.all([
        treasuryRead, memberRead,
        queryEval(rpcUrl, LAUNCHPAD_FEES_PATH, `LiabilityOf(${JSON.stringify(currency)})`, true).then(qInt),
        queryEval(rpcUrl, LAUNCHPAD_CONFIG_PATH, "GetCurrentVersion()", true).then(qInt),
    ])
    if (versionAfter !== configVersion || treasuryClaimable > totalLiability ||
        (memberClaimable !== null && memberClaimable > totalLiability) ||
        (member !== null && member !== treasury && memberClaimable !== null &&
            treasuryClaimable + memberClaimable > totalLiability)) throw new Error("Proceeds changed during read. Refresh.")
    return { configVersion, treasury, treasuryClaimable, member, memberClaimable, totalLiability }
}

export async function readNativeProceeds(rpcUrl: string, member: string | null): Promise<NativeProceeds> {
    return readCurrencyProceeds(rpcUrl, member, "ugnot")
}

export function proceedsClaimScope(chainId: string, caller: string, currency: ProceedsCurrency = "ugnot"): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_FEES_PATH, caller, operation: `claim:${currency}` }
}

export function buildProceedsClaimMsg(caller: string, amount: bigint, currency: ProceedsCurrency = "ugnot"): AminoMsg {
    if (!ADDRESS.test(caller) || amount < 1n || (currency !== "ugnot" && currency !== WUGNOT_KEY)) throw new Error("No proceeds are ready to claim")
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_FEES_PATH,
        func: "Claim", args: [currency], max_deposit: `${CLAIM_STORAGE_CAP}ugnot` } }
}

export function claimProceedsRequest(input: {
    caller: string; amount: bigint; rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number;
    currency: ProceedsCurrency;
    onSettled?: () => void
}): SignRequest {
    const { caller, amount, rpcUrl, chainId, estimatedGasFeeUgnot, currency } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildProceedsClaimMsg(caller, amount, currency)
    const scope = proceedsClaimScope(chainId, caller, currency)
    const label = "Claim Launchpad proceeds"
    const unit = currency === "ugnot" ? "ugnot" : "wugnot"
    return {
        title: "Claim marketplace proceeds", summary: `${amount.toLocaleString()} ${unit} goes to ${caller}`,
        lines: () => [["Claimed amount", `${amount.toLocaleString()} ${unit}`], ["Currency key", currency], ["Receiver and signer", caller],
            ["Realm", LAUNCHPAD_FEES_PATH], ["Network", chainId],
            ["Gas limit", PROCEEDS_CLAIM_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${CLAIM_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The receiver must sign this transaction directly. DAO multisig proceeds require its own threshold signing process."],
        acks: ["I checked the receiver, amount and chain before opening Adena."],
        label: () => label, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            if (await claimable(rpcUrl, caller, currency) !== amount) throw new Error("Claimable amount changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: PROCEEDS_CLAIM_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => await claimable(rpcUrl, caller, currency) === 0n,
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain the conservative lock */ } }
            input.onSettled?.()
        },
    }
}

export function claimNativeProceedsRequest(input: Omit<Parameters<typeof claimProceedsRequest>[0], "currency">): SignRequest {
    return claimProceedsRequest({ ...input, currency: "ugnot" })
}
