# Tool surface of a running server started WITHOUT --obo (plain --http accepts any bearer for tools/list):
# python3 test/tools.py http://127.0.0.1:3000/mcp
import json,urllib.request,sys
BASE=sys.argv[1]; sid=None
def call(m,p=None,notif=False):
    global sid
    pl={"jsonrpc":"2.0","method":m}
    if not notif: pl["id"]=1
    if p is not None: pl["params"]=p
    h={"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":"Bearer dummy"}
    if sid: h["Mcp-Session-Id"]=sid
    r=urllib.request.urlopen(urllib.request.Request(BASE,data=json.dumps(pl).encode(),headers=h),timeout=60)
    sid=r.headers.get("Mcp-Session-Id") or sid; b=r.read().decode()
    if notif: return
    for ln in b.splitlines():
        if ln.startswith("data:"): return json.loads(ln[5:])
    return json.loads(b)
call("initialize",{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}); call("notifications/initialized",{},True)
names=[t["name"] for t in call("tools/list",{})["result"]["tools"]]
ex="download-bytes download-bytes-to-file get-mail-attachment-content add-mail-attachment create-mail-attachment-upload-session add-calendar-event-attachment create-calendar-event-attachment-upload-session graph-batch".split()
print(len(names),"tools | read-mail-text:", "read-mail-text" in names, "| get-download-url:", "get-download-url" in names, "| get-upload-url:", "get-upload-url" in names, "| excluded present:", [e for e in ex if e in names])
