package service

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	dbpkg "github.com/samouraiworld/memba/backend/internal/db"
)

func curationInboxDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := dbpkg.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := dbpkg.Migrate(database); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestCurationInboxRetentionDeletesExpiredContentAndAuditByChain(t *testing.T) {
	database := curationInboxDB(t)
	now := time.Now()
	old := now.Add(-31 * 24 * time.Hour).UnixMicro()
	newer := now.Add(-29 * 24 * time.Hour).UnixMicro()
	for _, row := range []struct {
		id, chain string
		created   int64
	}{
		{"expired", "gnoland-1", old}, {"current", "gnoland-1", newer}, {"other-chain", "pearl-1", old},
	} {
		if _, err := database.Exec(`INSERT INTO launchpad_curation_messages
			(id,chain_id,collection,revision,sender,client_id,created_at,nonce,ciphertext)
			VALUES (?,?, 'C1',1,'sender',?,?,x'00',x'00')`, row.id, row.chain, row.id, row.created); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Exec(`INSERT INTO launchpad_curation_message_audit
			(chain_id,collection,actor,action,created_at) VALUES (?,'C1','sender','read',?)`, row.chain, row.created); err != nil {
			t.Fatal(err)
		}
	}
	if err := PurgeCurationInbox(context.Background(), database, "gnoland-1", 30, now); err != nil {
		t.Fatal(err)
	}
	var ids []string
	rows, err := database.Query(`SELECT id FROM launchpad_curation_messages ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != "current" || ids[1] != "other-chain" {
		t.Fatalf("retained messages=%v", ids)
	}
	var auditCount int
	if err := database.QueryRow(`SELECT COUNT(*) FROM launchpad_curation_message_audit WHERE chain_id='gnoland-1'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("retained audit=%d err=%v", auditCount, err)
	}
	if err := PurgeCurationInbox(context.Background(), database, "gnoland-1", 0, now); err == nil {
		t.Fatal("zero-day policy accepted")
	}
	config := CurationInboxConfig{RPCURL: "https://rpc.example", ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x42}, 32), AllowSend: func(string) bool { return true }}
	if _, err := NewCurationInboxHandler(database, config); err == nil {
		t.Fatal("missing retention policy enabled inbox")
	}
	config.RetentionDays = 366
	if _, err := NewCurationInboxHandler(database, config); err == nil {
		t.Fatal("excessive retention policy enabled inbox")
	}
}

func curationInboxRequest(h http.Handler, method, clientID, message string) *httptest.ResponseRecorder {
	path := "/api/nft/curation-thread?collection=C1"
	var body *strings.Reader
	if method == http.MethodPost {
		payload, _ := json.Marshal(curationSendRequest{ClientID: clientID, Text: message})
		body = strings.NewReader(string(payload))
	} else {
		body = strings.NewReader("")
	}
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(WithAuthAddress(r.Context(), accessTestWallet))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCurationInboxEncryptsAndRechecksEveryRequest(t *testing.T) {
	database := curationInboxDB(t)
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"2","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	key := bytes.Repeat([]byte{0x42}, 32)
	h, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1", Key: key, RetentionDays: 30,
		AllowSend: func(string) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	clientID := strings.Repeat("a", 32)
	w := curationInboxRequest(h, http.MethodPost, clientID, "Private launch details")
	if w.Code != http.StatusCreated || !strings.Contains(w.Body.String(), "Private launch details") {
		t.Fatalf("send status=%d body=%s", w.Code, w.Body.String())
	}
	var first curationMessage
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	var encrypted []byte
	if err := database.QueryRow(`SELECT ciphertext FROM launchpad_curation_messages WHERE id=?`, first.ID).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("Private launch details")) {
		t.Fatal("private text was stored in plaintext")
	}
	w = curationInboxRequest(h, http.MethodPost, clientID, "Private launch details")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), first.ID) {
		t.Fatalf("idempotent retry status=%d body=%s", w.Code, w.Body.String())
	}
	w = curationInboxRequest(h, http.MethodPost, clientID, "Different details")
	if w.Code != http.StatusConflict {
		t.Fatalf("reused id with different text status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodPost, strings.Repeat("b", 32), strings.Repeat("x", 9000))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized private message status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Private launch details") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("read status=%d body=%s", w.Code, w.Body.String())
	}
	if queries != 5 {
		t.Fatalf("every send/retry/read must recheck current chain access, queries=%d", queries)
	}
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM launchpad_curation_messages`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("idempotent store count=%d err=%v", count, err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM launchpad_curation_message_audit`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("send/read audit count=%d err=%v", count, err)
	}
	if _, err := database.Exec(`UPDATE launchpad_curation_messages SET ciphertext=x'00' WHERE id=?`, first.ID); err != nil {
		t.Fatal(err)
	}
	w = curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "Private launch details") {
		t.Fatalf("tampered ciphertext must fail closed, status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCurationInboxRejectsLostRoleWrongChainAndInvalidKey(t *testing.T) {
	database := curationInboxDB(t)
	if _, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: "https://rpc.example", ChainID: "gnoland-1",
		Key: []byte("short"), RetentionDays: 30, AllowSend: func(string) bool { return true }}); err == nil {
		t.Fatal("missing encryption key must disable inbox")
	}
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"2","status":"submitted","isFounder":false,"isManager":false,"canRead":false,"canReview":false}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	h, err := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), RetentionDays: 30, AllowSend: func(string) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	w := curationInboxRequest(h, http.MethodGet, "", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("removed manager read status=%d", w.Code)
	}
	w = curationInboxRequest(h, http.MethodPost, strings.Repeat("b", 32), "Hello")
	if w.Code != http.StatusForbidden {
		t.Fatalf("removed manager send status=%d", w.Code)
	}
	rpcWrong := accessRPCServer(t, "pearl-1", view, &queries)
	defer rpcWrong.Close()
	hWrong, _ := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpcWrong.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), RetentionDays: 30, AllowSend: func(string) bool { return true }})
	w = curationInboxRequest(hWrong, http.MethodGet, "", "")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("wrong RPC chain status=%d", w.Code)
	}
	hLimited, _ := NewCurationInboxHandler(database, CurationInboxConfig{RPCURL: rpc.URL, ChainID: "gnoland-1",
		Key: bytes.Repeat([]byte{0x24}, 32), RetentionDays: 30, AllowSend: func(string) bool { return false }})
	w = curationInboxRequest(hLimited, http.MethodPost, strings.Repeat("b", 32), "Hello")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("per-wallet send cap status=%d", w.Code)
	}
}
