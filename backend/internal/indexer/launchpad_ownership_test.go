package indexer

import (
	"context"
	"database/sql"
	"testing"
)

const (
	ownerA = "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	ownerB = "g1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	issuer = "g1cccccccccccccccccccccccccccccccccccccc"
)

func ownershipEvent(kind string, block int64, index int, attrs map[string]string) GnoEvent {
	return GnoEvent{
		Type: kind, PkgPath: launchpadNFTRealm, Attrs: attrs,
		Block: block, TxIndex: 0, EventIdx: index,
	}
}

func TestLaunchpadOwnershipLifecycleAndRollback(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	mint := ownershipEvent("LaunchpadNFTMinted", 10, 0, map[string]string{
		"collection": "C1", "number": "1", "recipient": ownerA,
	})
	transfer := ownershipEvent("LaunchpadNFTTransferred", 11, 0, map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": ownerB, "actor": ownerA,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", mint); err != nil {
		t.Fatal(err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", mint); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", transfer); err != nil {
		t.Fatal(err)
	}
	got, err := GetLaunchpadTokenOwnership(ctx, database, "gnoland-1", "C1", 1)
	if err != nil || got.Owner != ownerB || got.Status != "active" || got.Block != 11 {
		t.Fatalf("after transfer: %+v, %v", got, err)
	}
	if err := rollbackLaunchpadTailerFromHeight(ctx, database, "gnoland-1", 11); err != nil {
		t.Fatal(err)
	}
	got, err = GetLaunchpadTokenOwnership(ctx, database, "gnoland-1", "C1", 1)
	if err != nil || got.Owner != ownerA || got.Block != 10 {
		t.Fatalf("after rollback: %+v, %v", got, err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", transfer); err != nil {
		t.Fatalf("replay after rollback: %v", err)
	}
	burn := ownershipEvent("LaunchpadNFTBurned", 12, 0, map[string]string{
		"collection": "C1", "number": "1", "holder": ownerB,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", burn); err != nil {
		t.Fatal(err)
	}
	got, err = GetLaunchpadTokenOwnership(ctx, database, "gnoland-1", "C1", 1)
	if err != nil || got.Owner != "" || got.Status != "burned" {
		t.Fatalf("after burn: %+v, %v", got, err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", transfer); err != nil {
		t.Fatalf("idempotent replay of prior transfer: %v", err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", ownershipEvent(
		"LaunchpadNFTTransferred", 13, 0, transfer.Attrs)); err == nil {
		t.Fatal("transfer after burn accepted")
	}
}

func TestLaunchpadOwnershipRejectsGapsConflictsAndOtherRealms(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	transfer := ownershipEvent("LaunchpadNFTTransferred", 11, 0, map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": ownerB, "actor": ownerA,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", transfer); err == nil {
		t.Fatal("transfer without mint accepted")
	}
	mint := ownershipEvent("LaunchpadNFTMinted", 10, 0, map[string]string{
		"collection": "C1", "number": "1", "recipient": ownerA,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "", mint); err == nil {
		t.Fatal("empty chain accepted")
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", mint); err != nil {
		t.Fatal(err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", transfer); err != nil {
		t.Fatal(err)
	}
	wrongFrom := ownershipEvent("LaunchpadNFTTransferred", 12, 0, map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": issuer, "actor": ownerA,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", wrongFrom); err == nil {
		t.Fatal("wrong prior owner accepted")
	}
	stale := ownershipEvent("LaunchpadNFTTransferred", 10, 1, map[string]string{
		"collection": "C1", "number": "1", "from": ownerB, "to": issuer, "actor": ownerB,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", stale); err == nil {
		t.Fatal("out-of-order event accepted")
	}
	conflict := transfer
	conflict.Attrs = map[string]string{
		"collection": "C1", "number": "1", "from": ownerA, "to": issuer, "actor": ownerA,
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", conflict); err == nil {
		t.Fatal("conflicting event at same coordinate accepted")
	}
	other := mint
	other.PkgPath = "gno.land/r/attacker/nft"
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", other); err != nil {
		t.Fatal(err)
	}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "pearl-1", mint); err != nil {
		t.Fatalf("other chain isolated: %v", err)
	}
	if err := rollbackLaunchpadTailerFromHeight(ctx, database, "gnoland-1", 10); err != nil {
		t.Fatal(err)
	}
	if _, err := GetLaunchpadTokenOwnership(ctx, database, "gnoland-1", "C1", 1); err != sql.ErrNoRows {
		t.Fatalf("old chain owner still exists: %v", err)
	}
	if got, err := GetLaunchpadTokenOwnership(ctx, database, "pearl-1", "C1", 1); err != nil || got.Owner != ownerA {
		t.Fatalf("other chain changed: %+v, %v", got, err)
	}
}

func TestLaunchpadOwnershipRevocationAndMalformedEvents(t *testing.T) {
	database := openTestDB(t)
	ctx := context.Background()
	mint := ownershipEvent("LaunchpadNFTMinted", 20, 0, map[string]string{
		"collection": "C2", "number": "1", "recipient": ownerA,
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", mint); err != nil {
		t.Fatal(err)
	}
	revoke := ownershipEvent("LaunchpadNFTRevoked", 21, 0, map[string]string{
		"collection": "C2", "number": "1", "holder": ownerA,
		"issuer": issuer, "reason": "eligibility_lost",
	})
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", revoke); err != nil {
		t.Fatal(err)
	}
	got, err := GetLaunchpadTokenOwnership(ctx, database, "gnoland-1", "C2", 1)
	if err != nil || got.Status != "revoked" || got.Owner != "" {
		t.Fatalf("revocation: %+v, %v", got, err)
	}
	bad := mint
	bad.Block = 22
	bad.Attrs = map[string]string{"collection": "C3", "number": "01", "recipient": ownerA}
	if err := ApplyLaunchpadOwnershipEvent(ctx, database, "gnoland-1", bad); err == nil {
		t.Fatal("noncanonical token number accepted")
	}
}
