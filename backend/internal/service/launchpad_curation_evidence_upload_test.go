package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const evidenceTestCID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"

func evidenceRequest(body string, authenticated bool) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/nft/curation-evidence/upload?collection=C1", strings.NewReader(body))
	r.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if authenticated {
		r = r.WithContext(WithAuthAddress(r.Context(), accessTestWallet))
	}
	return r
}

func TestCurationEvidenceUploadPinsExactPublicBytes(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	content := "Public collection launch plan\nArtist and collection history"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-only-key" {
			t.Error("pinning bearer missing")
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		defer func() { _ = file.Close() }()
		data, err := io.ReadAll(file)
		if err != nil || string(data) != content || header.Filename != "curation-evidence.txt" ||
			header.Header.Get("Content-Type") != "text/plain; charset=utf-8" {
			t.Errorf("wrong pinned bytes or metadata: %q %v", data, err)
		}
		_, _ = io.WriteString(w, `{"Hash":"`+evidenceTestCID+`"}`)
	}))
	defer upstream.Close()
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"1","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	allowCalls := 0
	h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(wallet string) bool { allowCalls++; return wallet == accessTestWallet }, ipfsUploadOptions{uploadURL: upstream.URL})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, evidenceRequest(content, true))
	if w.Code != http.StatusCreated || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var result struct {
		CID    string `json:"cid"`
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(content))
	if result.CID != evidenceTestCID || result.SHA256 != hex.EncodeToString(digest[:]) || allowCalls != 1 || queries != 1 {
		t.Fatalf("unexpected pin result %+v, limit calls %d", result, allowCalls)
	}
}

func TestCurationEvidenceUploadRejectsUnauthenticatedAndInvalidContent(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	h := HandleCurationEvidenceUpload("http://127.0.0.1:1", "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: "http://127.0.0.1:1"})
	cases := []struct {
		name string
		req  *http.Request
		want int
	}{
		{"no wallet", evidenceRequest("Public text", false), http.StatusUnauthorized},
		{"too large", evidenceRequest(strings.Repeat("a", curationEvidenceMaxBytes+1), true), http.StatusRequestEntityTooLarge},
		{"invalid UTF-8", evidenceRequest(string([]byte{0xff}), true), http.StatusBadRequest},
		{"empty", evidenceRequest("  \n", true), http.StatusBadRequest},
		{"nul", evidenceRequest("public\x00text", true), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, tc.req)
			if w.Code != tc.want {
				t.Fatalf("status=%d, want=%d", w.Code, tc.want)
			}
		})
	}
	wrongType := evidenceRequest("Public text", true)
	wrongType.Header.Set("Content-Type", "text/html")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, wrongType)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("HTML accepted: %d", w.Code)
	}
	limited := HandleCurationEvidenceUpload("http://127.0.0.1:1", "gnoland-1", func(string) bool { return false })
	w = httptest.NewRecorder()
	limited.ServeHTTP(w, evidenceRequest("Public text", true))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("per-wallet cap ignored: %d", w.Code)
	}
}

func TestCurationEvidenceUploadRejectsMalformedPinResponse(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"1","status":"submitted","isFounder":false,"isManager":true,"canRead":true,"canReview":true}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"Hash":"https://example.com"}`)
	}))
	defer upstream.Close()
	h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: upstream.URL})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, evidenceRequest("Public text", true))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("malformed CID accepted: %d", w.Code)
	}
}

func TestCurationEvidenceUploadAllowsInitialCreator(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status" {
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{
				"node_info": map[string]string{"network": "gnoland-1"},
				"sync_info": map[string]any{"latest_block_height": "100", "latest_block_time": time.Now().UTC().Format(time.RFC3339Nano), "catching_up": false},
			}})
			return
		}
		var query abciQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&query); err != nil {
			t.Error(err)
		}
		expr, err := base64.StdEncoding.DecodeString(query.Params.Data)
		if err != nil {
			t.Error(err)
		}
		view := "null"
		if string(expr) == launchpadCurationPath+`.EditorialAccessJSON("C1","`+accessTestWallet+`")` {
			view = `{"collection":"C1","account":"` + accessTestWallet + `","creator":"` + accessTestWallet + `","isManager":false}`
		} else if string(expr) != launchpadCurationPath+`.ReviewAccessJSON("C1","`+accessTestWallet+`")` {
			t.Errorf("unexpected query %q", expr)
		}
		typed := "(" + strconv.Quote(view) + " string)"
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"response": map[string]any{
			"ResponseBase": map[string]any{"Data": base64.StdEncoding.EncodeToString([]byte(typed)), "Error": nil},
		}}})
	}))
	defer rpc.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"Hash":"`+evidenceTestCID+`"}`)
	}))
	defer upstream.Close()
	h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: upstream.URL})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, evidenceRequest("Public founder application", true))
	if w.Code != http.StatusCreated {
		t.Fatalf("creator status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCurationEvidenceUploadAllowsUnreviewedManagerButRejectsOthers(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	for _, tc := range []struct {
		name    string
		creator string
		manager bool
		want    int
	}{
		{"manager without application", accessTestFounder, true, http.StatusCreated},
		{"unassigned wallet", accessTestFounder, false, http.StatusForbidden},
		{"self-manager claim", accessTestWallet, true, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/status" {
					_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{
						"node_info": map[string]string{"network": "gnoland-1"},
						"sync_info": map[string]any{"latest_block_height": "100", "latest_block_time": time.Now().UTC().Format(time.RFC3339Nano), "catching_up": false},
					}})
					return
				}
				var query abciQueryRequest
				if err := json.NewDecoder(r.Body).Decode(&query); err != nil {
					t.Error(err)
				}
				expr, err := base64.StdEncoding.DecodeString(query.Params.Data)
				if err != nil {
					t.Error(err)
				}
				view := "null"
				if string(expr) == launchpadCurationPath+`.EditorialAccessJSON("C1","`+accessTestWallet+`")` {
					view = `{"collection":"C1","account":"` + accessTestWallet + `","creator":"` + tc.creator + `","isManager":` + strconv.FormatBool(tc.manager) + `}`
				} else if string(expr) != launchpadCurationPath+`.ReviewAccessJSON("C1","`+accessTestWallet+`")` {
					t.Errorf("unexpected query %q", expr)
				}
				typed := "(" + strconv.Quote(view) + " string)"
				_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"response": map[string]any{
					"ResponseBase": map[string]any{"Data": base64.StdEncoding.EncodeToString([]byte(typed)), "Error": nil},
				}}})
			}))
			defer rpc.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"Hash":"`+evidenceTestCID+`"}`)
			}))
			defer upstream.Close()
			h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: upstream.URL})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, evidenceRequest("Public emergency hold reason", true))
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}

func TestCurationEvidenceUploadDeniesUnassignedWallet(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"1","status":"submitted","isFounder":false,"isManager":false,"canRead":false,"canReview":false}`
	queries := 0
	rpc := accessRPCServer(t, "gnoland-1", view, &queries)
	defer rpc.Close()
	h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: "http://127.0.0.1:1"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, evidenceRequest("Public text", true))
	if w.Code != http.StatusForbidden || queries != 1 {
		t.Fatalf("unassigned wallet status=%d queries=%d", w.Code, queries)
	}
}

func TestCurationEvidenceUploadAllowsManagerAfterReview(t *testing.T) {
	t.Setenv("LIGHTHOUSE_API_KEY", "test-only-key")
	for _, status := range []string{"recommended", "declined"} {
		t.Run(status, func(t *testing.T) {
			view := `{"collection":"C1","account":"` + accessTestWallet + `","founder":"` + accessTestFounder + `","revision":"1","status":"` + status + `","isFounder":false,"isManager":true,"canRead":true,"canReview":false}`
			queries := 0
			rpc := accessRPCServer(t, "gnoland-1", view, &queries)
			defer rpc.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"Hash":"`+evidenceTestCID+`"}`)
			}))
			defer upstream.Close()
			h := HandleCurationEvidenceUpload(rpc.URL, "gnoland-1", func(string) bool { return true }, ipfsUploadOptions{uploadURL: upstream.URL})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, evidenceRequest("Public editorial reason", true))
			if w.Code != http.StatusCreated || queries != 1 {
				t.Fatalf("status=%d queries=%d body=%s", w.Code, queries, w.Body.String())
			}
		})
	}
}
