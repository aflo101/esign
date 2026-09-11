#!/bin/bash
# Regression suite — proves each fixed security/integrity bug stays fixed.
# Prereqs: backend running on :4000 (local dev, auth off, against the esign-dev table),
# and a test PDF at /tmp/phase0-test.pdf — generate one with:
#   cd backend && node -e "const {PDFDocument,StandardFonts}=require('pdf-lib');(async()=>{const d=await PDFDocument.create();const p=d.addPage([612,792]);p.drawText('test',{x:72,y:700,size:18,font:await d.embedFont(StandardFonts.Helvetica)});require('fs').writeFileSync('/tmp/phase0-test.pdf',await d.save())})()"
API=http://localhost:4000
PDF=/tmp/phase0-test.pdf
pass=0; fail=0
chk() { if [ "$2" == "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
        else echo "  FAIL  $1  (expected $2, got $3)"; fail=$((fail+1)); fi }

# 3-step presigned upload: init -> PUT to S3 -> complete. Echoes the document id.
upload() {
  local init id url
  init=$(curl -s -X POST $API/documents/init -H 'Content-Type: application/json' -d '{"filename":"test.pdf"}')
  id=$(echo "$init" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  url=$(echo "$init" | python3 -c 'import json,sys;print(json.load(sys.stdin)["uploadUrl"])')
  curl -s -X PUT -H 'Content-Type: application/pdf' --data-binary "@$PDF" "$url" >/dev/null
  curl -s -X POST $API/documents/$id/complete -H 'Content-Type: application/json' \
    -d "{\"filename\":\"test.pdf\",\"sender_email\":\"sender@test.local\"}" >/dev/null
  echo "$id"
}
place() { curl -s -X PUT $API/documents/$1/fields -H 'Content-Type: application/json' \
  -d '{"fields":[{"type":"name","page":0,"x":0.1,"y":0.1,"w":0.3,"h":0.05,"required":true,"sort_order":0}]}' >/dev/null; }
send() { curl -s -X POST $API/documents/$1/send -H 'Content-Type: application/json' \
  -d "{\"signer_email\":\"$2\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["link"].rsplit("/",1)[1])'; }
fieldid() { curl -s $API/sign/$1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["fields"][0]["id"])'; }
# send with a cc — returns the raw JSON body so cc_emails / errors can be asserted.
sendcc() { curl -s -X POST $API/documents/$1/send -H 'Content-Type: application/json' \
  -d "{\"signer_email\":\"$2\",\"cc_email\":\"$3\"}"; }
sendccode() { curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$1/send \
  -H 'Content-Type: application/json' -d "{\"signer_email\":\"$2\",\"cc_email\":\"$3\"}"; }
jqf() { python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d.get('$1','')) if not isinstance(d.get('$1'),str) else d['$1'])"; }

# Build the JSON in a variable — inlining escaped quotes inside "$( ... )" mangles them
# into invalid JSON, which express rejects at the body parser (400) before any route runs.
signreq() { # signreq <token> <fieldId> <value> [noconsent]
  local body
  if [ "$4" = "noconsent" ]; then body=$(printf '{"values":{"%s":"%s"}}' "$2" "$3")
  else body=$(printf '{"consent":true,"values":{"%s":"%s"}}' "$2" "$3"); fi
  curl -s -o /dev/null -w '%{http_code}' -X POST $API/sign/$1 -H 'Content-Type: application/json' -d "$body"
}
signfull() { local body; body=$(printf '{"consent":true,"values":{"%s":"%s"}}' "$2" "$3")
  curl -s -X POST $API/sign/$1 -H 'Content-Type: application/json' -d "$body"; }

echo "=== presigned upload path ==="
ID=$(upload); place $ID
chk "upload via presigned PUT registers a document" "200" "$(curl -s -o /dev/null -w '%{http_code}' $API/documents/$ID/fields)"
chk "pdf endpoint returns a presigned URL, not bytes" "true" \
  "$(curl -s $API/documents/$ID/pdf | python3 -c 'import json,sys;print(str("amazonaws.com" in json.load(sys.stdin)["url"]).lower())')"
chk "non-PDF bytes rejected at complete" "400" \
  "$(I2=$(curl -s -X POST $API/documents/init -H 'Content-Type: application/json' -d '{"filename":"x.pdf"}'); \
     U2=$(echo "$I2"|python3 -c 'import json,sys;print(json.load(sys.stdin)["uploadUrl"])'); \
     D2=$(echo "$I2"|python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'); \
     curl -s -X PUT -H 'Content-Type: application/pdf' --data-binary 'NOT-A-PDF' "$U2" >/dev/null; \
     curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$D2/complete -H 'Content-Type: application/json' -d '{\"filename\":\"x.pdf\"}')"

echo "=== field-count limit is honest (50; edits must not brick) ==="
BIGF=$(python3 -c "import json;print(json.dumps({'fields':[{'type':'text','page':0,'x':0.1,'y':0.1,'w':0.2,'h':0.03,'required':False,'sort_order':i} for i in range(50)]}))")
chk "50 fields accepted" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $API/documents/$ID/fields -H 'Content-Type: application/json' -d "$BIGF")"
chk "50 fields RE-SAVED (delete+put fits one transaction)" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $API/documents/$ID/fields -H 'Content-Type: application/json' -d "$BIGF")"
BIG51=$(python3 -c "import json;print(json.dumps({'fields':[{'type':'text','page':0,'x':0.1,'y':0.1,'w':0.2,'h':0.03,'required':False,'sort_order':i} for i in range(51)]}))")
chk "51 fields rejected with a clear error" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $API/documents/$ID/fields -H 'Content-Type: application/json' -d "$BIG51")"
place $ID  # restore a single required field for the signing tests below

echo "=== BUG 1: signed document cannot be re-sent ==="
T1=$(send $ID alice@test.local); FID=$(fieldid $T1)
signfull $T1 $FID Alice >/dev/null
sleep 1
chk "re-send of a signed doc is rejected" "409" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$ID/send -H 'Content-Type: application/json' -d '{"signer_email":"mallory@test.local"}')"
chk "second sign attempt is rejected" "410" "$(signreq $T1 $FID Mallory)"

echo "=== BUG 2: stale token cannot sign after re-send to a different signer ==="
ID2=$(upload); place $ID2
TA=$(send $ID2 alice@test.local); F2=$(fieldid $TA)
send $ID2 bob@test.local >/dev/null
chk "Alice's token cannot sign after re-send to Bob" "401" "$(signreq $TA $F2 Alice)"
chk "Alice's token cannot open the doc" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/sign/$TA)"
chk "Alice's token cannot get a PDF URL"  "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/sign/$TA/pdf)"

echo "=== BUG 2b: superseded link dies on re-send to the SAME signer ==="
ID3=$(upload); place $ID3
TOLD=$(send $ID3 carol@test.local); TNEW=$(send $ID3 carol@test.local)
chk "superseded link is dead" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/sign/$TOLD)"
chk "reissued link works"     "200" "$(curl -s -o /dev/null -w '%{http_code}' $API/sign/$TNEW)"

echo "=== BUG 3: evidence PDF does not leak the signing token ==="
EVURL=$(curl -s $API/documents/$ID/evidence | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -s "$EVURL" -o /tmp/phase0-evidence.pdf
EV=$(pdftotext /tmp/phase0-evidence.pdf - 2>/dev/null)
[ -z "$EV" ] && { echo "  FAIL  evidence extraction returned nothing"; fail=$((fail+1)); }
echo "$EV" | grep -q "$T1"    && chk "token absent from evidence PDF" "absent"  "PRESENT" || chk "token absent from evidence PDF" "absent" "absent"
echo "$EV" | grep -q "token_fp" && chk "fingerprint present instead"  "present" "present" || chk "fingerprint present instead" "present" "MISSING"

echo "=== ESIGN consent + opaque tokens ==="
ID4=$(upload); place $ID4
T4=$(send $ID4 dave@test.local); F4=$(fieldid $T4)
chk "signing without consent is rejected" "400" "$(signreq $T4 $F4 Dave noconsent)"
chk "token is opaque, not a JWT" "true" "$(python3 -c "print(str(not '$T4'.startswith('eyJ')).lower())")"
chk "token is short (<=24 chars)" "true" "$(python3 -c "print(str(len('$T4')<=24).lower())")"
chk "signing with consent succeeds" "200" "$(signreq $T4 $F4 Dave)"
sleep 1
EV4=$(curl -s $API/documents/$ID4/evidence | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -s "$EV4" -o /tmp/ev4.pdf; T4TXT=$(pdftotext /tmp/ev4.pdf - 2>/dev/null)
echo "$T4TXT" | grep -q "consent_given" && chk "consent recorded in evidence PDF" "yes" "yes" || chk "consent recorded in evidence PDF" "yes" "MISSING"
echo "$T4TXT" | grep -q "document_signed" && chk "document_signed present in evidence PDF" "yes" "yes" || chk "document_signed present in evidence PDF" "yes" "MISSING"

echo "=== CC on the signature request ==="
ID5=$(upload); place $ID5
CC5=$(sendcc $ID5 erin@test.local "cc-one@test.local, cc-two@test.local")
chk "cc addresses echoed back on send" '["cc-one@test.local", "cc-two@test.local"]' "$(echo "$CC5" | jqf cc_emails)"
chk "comma-separated cc list is split" "2" \
  "$(echo "$CC5" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["cc_emails"]))')"
# A cc equal to the signer would make SES reject the whole Destination and 500 a send whose
# token is already live — it must be dropped, not passed through.
chk "self-cc (cc == signer) is dropped" '""' \
  "$(sendcc $ID5 erin@test.local "erin@test.local" | jqf cc_emails)"
chk "case-insensitive duplicate cc is deduped" "1" \
  "$(sendcc $ID5 erin@test.local "Dup@test.local, dup@test.local" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["cc_emails"]))')"
chk "malformed cc is rejected before send" "400" "$(sendccode $ID5 erin@test.local "not-an-email")"
chk "cc over the cap is rejected" "400" \
  "$(sendccode $ID5 erin@test.local "a@t.co,b@t.co,c@t.co,d@t.co,e@t.co,f@t.co,g@t.co,h@t.co,i@t.co,j@t.co,k@t.co")"
# A cc dropped from a re-send must not survive from the previous send.
chk "re-send without cc clears the previous cc" '""' "$(sendcc $ID5 erin@test.local "" | jqf cc_emails)"

echo "=== CC receives the executed document ==="
ID6=$(upload); place $ID6
sendcc $ID6 frank@test.local "watcher@test.local" >/dev/null
T6=$(curl -s -X POST $API/documents/$ID6/send -H 'Content-Type: application/json' \
  -d '{"signer_email":"frank@test.local","cc_email":"watcher@test.local"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["link"].rsplit("/",1)[1])')
F6=$(fieldid $T6)
chk "signing a cc'd document succeeds" "200" "$(signreq $T6 $F6 Frank)"
sleep 1
EV6=$(curl -s $API/documents/$ID6/evidence | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -s "$EV6" -o /tmp/ev6.pdf; T6TXT=$(pdftotext /tmp/ev6.pdf - 2>/dev/null)
# The cc holds a signable credential, so the evidence package must name them.
echo "$T6TXT" | grep -q "watcher@test.local" && chk "cc recorded in evidence PDF" "yes" "yes" || chk "cc recorded in evidence PDF" "yes" "MISSING"
echo "$T6TXT" | grep -q "completion_emailed" && chk "completion delivered with cc present" "yes" "yes" || chk "completion delivered with cc present" "yes" "MISSING"

echo
echo "=== RESULT: $pass passed, $fail failed ==="
exit $fail
