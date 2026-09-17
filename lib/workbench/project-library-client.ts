'use client';

/** Uses the scope captured when the file was picked, including after an upload resumes. */
export async function fileProjectUpload(projectId: string, uploadId: string, scope: string) {
  try {
    const response = await fetch('/api/workbench/library',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':scope},body:JSON.stringify({projectId,uploadId}),signal:AbortSignal.timeout(20000)});
    const result = await response.json().catch(()=>null);
    if (!response.ok || result?.ok !== true) throw new Error(typeof result?.error==='string'?result.error:'Project filing could not be confirmed.');
  } catch(error) {
    throw new Error(`${error instanceof Error?error.message:'Project filing could not be confirmed.'} The original is stored in the upload workspace’s All assets; add it to this project from there.`);
  }
}

export async function unfileProjectUpload(projectId:string,uploadId:string,scope:string) {
  const response=await fetch('/api/workbench/library',{method:'DELETE',headers:{'Content-Type':'application/json','X-Workbench-Scope':scope},body:JSON.stringify({projectId,uploadId}),signal:AbortSignal.timeout(20000)});
  const result=await response.json().catch(()=>null);
  if(!response.ok||result?.ok!==true)throw new Error(result?.error||'Project filing removal could not be confirmed. Refresh the library to check; the original has not been deleted.');
}
