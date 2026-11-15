"""Export public browser artifacts; raw trace credentials remain private."""
from pathlib import Path
import argparse,json,hashlib,shutil
from sanitize_trace import sanitize,discover
p=argparse.ArgumentParser();p.add_argument('raw');p.add_argument('output');a=p.parse_args();raw=Path(a.raw);output=Path(a.output);output.mkdir(parents=True,exist_ok=True);rows=[]
for trace in sorted(raw.rglob('trace.zip')):
 target=output/trace.relative_to(raw);report=sanitize(trace,target);(target.parent/'trace-redaction.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));rows.append({'trace':target.relative_to(output).as_posix(),**{k:v for k,v in report.items()if k!='entries'}})
for image in raw.rglob('*.png'):
 target=output/image.relative_to(raw);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(image,target)
# Error DOM captures may contain token-only-once pages. The portable trace already
# contains their scrubbed snapshots; preserve raw hashes and avoid another copy.
omitted=[{'file':str(path.relative_to(raw)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'reason':'raw DOM may contain one-time credentials; sanitized DOM available in trace'}for path in raw.rglob('error-context.md')]
(output/'browser-evidence.json').write_text(json.dumps({'ok':True,'portableTraces':rows,'omittedRawDOM':omitted,'rawPreservedPrivately':True,'separateProductScreenshots':len(list(output.rglob('*.png')))},ensure_ascii=False,indent=2));print(json.dumps({'ok':True,'portableTraces':len(rows),'separateProductScreenshots':len(list(output.rglob('*.png')))}))
