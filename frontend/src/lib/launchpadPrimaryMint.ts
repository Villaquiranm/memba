/** Exact native-price primary mint review, including recipient-claimed Soulbound NFTs. */
import { queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { readActionTerms, type LaunchpadActionTerms } from "./launchpadActionTerms"
import { formatGnotPrice } from "./launchpadListing"
import { readFixedDropStages, type FixedDropStage } from "./launchpadDropStages"
import { getLaunchpadNftCollection, getLaunchpadNftToken, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_DROPS_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

export const MINT_FIXED_GAS_WANTED = 50_000_000
const STORAGE_CAP = 5_000_000
const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/

export interface NativeMintReadiness {
    buyer: string
    collection: LaunchpadNftCollection
    stage: FixedDropStage
    claimed: bigint
    terms: LaunchpadActionTerms
}

export function primaryMintSplit(price: bigint, feeBPS: bigint): { protocol: bigint; creator: bigint } {
    if (price < 0n || feeBPS < 0n || feeBPS > 500n) throw new Error("Invalid primary mint fee")
    const protocol = price * feeBPS / 10_000n
    return { protocol, creator: price - protocol }
}

function stageEndLabel(seconds: bigint): string {
    const date = new Date(Number(seconds) * 1000)
    return Number.isFinite(date.valueOf()) ? date.toISOString() : `${seconds.toString()} Unix seconds`
}

async function readClaimed(rpcUrl: string, collection: string, index: number, buyer: string): Promise<bigint> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_DROPS_PATH,
        `ClaimedInStage(${JSON.stringify(collection)}, ${index}, ${JSON.stringify(buyer)})`, true)
    const match = /^\((0|[1-9]\d*) int64\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify your stage mint count")
    return BigInt(match[1])
}

export async function readNativeMintReadiness(rpcUrl: string, collectionID: string, index: number, buyer: string): Promise<NativeMintReadiness> {
    if (!/^C[1-9]\d*$/.test(collectionID) || !Number.isSafeInteger(index) || index < 0 || index >= 10 || !ADDRESS.test(buyer)) {
        throw new Error("Invalid primary mint identity")
    }
    const [collection, stages, terms, claimed] = await Promise.all([
        getLaunchpadNftCollection(rpcUrl, collectionID), readFixedDropStages(rpcUrl, collectionID),
        readActionTerms(rpcUrl, "drops", "ugnot"), readClaimed(rpcUrl, collectionID, index, buyer),
    ])
    const stage = stages[index]
    if (!stage || stage.currency !== "ugnot" || claimed > stage.perWallet) throw new Error("Native primary stage is unavailable")
    return { buyer, collection, stage, claimed, terms }
}

export function validateNativeMint(readiness: NativeMintReadiness, now = BigInt(Math.floor(Date.now() / 1000))): void {
    const { buyer, collection, stage, claimed, terms } = readiness
    if (!ADDRESS.test(buyer) || !ADDRESS.test(collection.creator) || collection.id !== stage.collection ||
        stage.currency !== "ugnot" || !terms.actionReady || terms.lane !== "drops" || terms.currency !== "ugnot" ||
        terms.primaryFeeBPS < 0n || terms.primaryFeeBPS > 500n || terms.version < 1n || !ADDRESS.test(terms.treasury)) {
        throw new Error("Native primary mint is unavailable under current DAO policy.")
    }
    if (now < stage.start || now >= stage.end || (stage.supplyCap > 0n && stage.minted >= stage.supplyCap) ||
        claimed >= stage.perWallet || !collection.revealed ||
        (collection.maxSupply > 0n && collection.minted >= collection.maxSupply)) {
        throw new Error("This stage is closed, sold out, at your wallet limit, or awaiting reveal.")
    }
}

export function mintFixedScope(chainId: string, readiness: NativeMintReadiness): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_DROPS_PATH, caller: readiness.buyer,
        operation: `mint-fixed:${readiness.collection.id}:${readiness.stage.index}` }
}

export function buildMintFixedMsg(readiness: NativeMintReadiness, now?: bigint): AminoMsg {
    validateNativeMint(readiness, now)
    return { type: "vm/MsgCall", value: { caller: readiness.buyer,
        send: readiness.stage.price === 0n ? "" : `${readiness.stage.price.toString()}ugnot`,
        pkg_path: LAUNCHPAD_DROPS_PATH, func: "MintFixed",
        args: [readiness.collection.id, readiness.stage.index.toString(), readiness.terms.version.toString()],
        max_deposit: `${STORAGE_CAP}ugnot` } }
}

function sameReadiness(a: NativeMintReadiness, b: NativeMintReadiness): boolean {
    return a.buyer === b.buyer && a.collection.id === b.collection.id && a.collection.creator === b.collection.creator &&
        a.collection.minted === b.collection.minted && a.collection.maxSupply === b.collection.maxSupply &&
        a.collection.revealed === b.collection.revealed && a.collection.mode === b.collection.mode &&
        a.stage.index === b.stage.index && a.stage.start === b.stage.start && a.stage.end === b.stage.end &&
        a.stage.price === b.stage.price && a.stage.supplyCap === b.stage.supplyCap &&
        a.stage.perWallet === b.stage.perWallet && a.stage.minted === b.stage.minted && a.stage.currency === b.stage.currency &&
        a.claimed === b.claimed && a.terms.version === b.terms.version && a.terms.treasury === b.terms.treasury &&
        a.terms.primaryFeeBPS === b.terms.primaryFeeBPS && a.terms.actionReady === b.terms.actionReady &&
        a.terms.currencyAllowed === b.terms.currencyAllowed && a.terms.laneReady === b.terms.laneReady &&
        a.terms.paused === b.terms.paused
}

export function mintFixedRequest(input: { readiness: NativeMintReadiness; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { readiness, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildMintFixedMsg(readiness)
    const { collection, stage, terms, buyer } = readiness
    const split = primaryMintSplit(stage.price, terms.primaryFeeBPS)
    const scope = mintFixedScope(chainId, readiness)
    const tokenNumber = collection.minted + 1n
    return {
        title: collection.mode === "soulbound" ? "Claim Soulbound NFT" : "Mint Launchpad NFT",
        summary: `${collection.name} #${tokenNumber.toString()} · ${stage.price === 0n ? "free mint" : formatGnotPrice(stage.price)}`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Token number", tokenNumber.toString()],
            ["Recipient and payer", buyer], ["Stage", (stage.index + 1).toString()],
            ["Stage closes", stageEndLabel(stage.end)],
            ["Mint price", stage.price === 0n ? "Free" : formatGnotPrice(stage.price)],
            ["DAO primary fee", `${formatGnotPrice(split.protocol)} (${terms.primaryFeeBPS.toString()} bps)`],
            ["DAO treasury", terms.treasury], ["Creator credit", `${formatGnotPrice(split.creator)} → ${collection.creator}`],
            ["Your stage mints", `${readiness.claimed.toString()} of ${stage.perWallet.toString()}`],
            ["Policy version", terms.version.toString()], ["Realm", LAUNCHPAD_DROPS_PATH], ["Network", chainId],
            ["Gas limit", MINT_FIXED_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["One transaction mints one token and credits the DAO and creator. The full displayed price is sent now; network gas is additional.",
            ...(collection.mode === "soulbound" ? ["This Soulbound token cannot be transferred or traded. You can burn it; the creator may revoke it only if that right was fixed at collection creation."] : []),
            "Collection media and provenance are creator-supplied. Review the exact collection and issuer before signing."],
        acks: ["I checked the collection, recipient, price, DAO fee, creator credit, rights and network."],
        label: () => `Mint ${collection.id} #${tokenNumber.toString()}`, receipt: scope,
        prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readNativeMintReadiness(rpcUrl, collection.id, stage.index, buyer)
            if (!sameReadiness(readiness, fresh)) throw new Error("Mint stage, ownership or DAO policy changed. Refresh before signing.")
            buildMintFixedMsg(fresh)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], `Mint ${collection.id} #${tokenNumber.toString()}`,
            { gasWanted: MINT_FIXED_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await readNativeMintReadiness(rpcUrl, collection.id, stage.index, buyer)
            if (fresh.collection.minted !== tokenNumber || fresh.stage.minted !== stage.minted + 1n ||
                fresh.claimed !== readiness.claimed + 1n) return false
            const token = await getLaunchpadNftToken(rpcUrl, collection.id, tokenNumber)
            return token.status === "active" && token.owner === buyer && token.soulbound === (collection.mode === "soulbound")
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}
