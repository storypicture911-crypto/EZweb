import { admin, audit, bodyOf, cors, generateCode, generateName, hashSecurityValue, hmac, internalEmail, json, INTERNAL_SECRET } from "../_shared/core.ts";

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(req)});
  try{
    const provided=req.headers.get("x-ezwin-bootstrap-secret")||"";
    if(!provided||await hmac(provided,"bootstrap-check")!==await hmac(INTERNAL_SECRET,"bootstrap-check"))return json(req,{error:"Forbidden"},403);
    const body=await bodyOf(req);if(!body)throw new Error("INVALID");
    const {count}=await admin.from("profiles").select("id",{count:"exact",head:true}).eq("role","admin");if((count||0)>0)return json(req,{error:"Bootstrap is already closed"},409);
    const userId=crypto.randomUUID();const generatedName=generateName();const email=internalEmail(userId);const password=`Bootstrap!${crypto.randomUUID()}${generateCode()}`;
    const {error:authError}=await admin.auth.admin.createUser({id:userId,email,password,email_confirm:true,user_metadata:{managed_by:"ezwin",bootstrap_admin:true}});if(authError)throw authError;
    try{const code=generateCode();const expiresAt=new Date(Date.now()+24*60*60_000).toISOString();const codeHash=await hashSecurityValue(`${userId}:${code}`);
      await admin.from("profiles").insert({id:userId,generated_name:generatedName,nickname:String(body.nickname||"EZWin Admin").trim().slice(0,30),role:"admin"});
      await admin.from("auth_identities").insert({user_id:userId,internal_email:email});await admin.from("activation_codes").insert({user_id:userId,code_hash:codeHash,expires_at:expiresAt});
      await audit(admin,userId,"ADMIN_BOOTSTRAPPED","profile",userId);return json(req,{generated_name:generatedName,one_time_code:code,expires_at:expiresAt});
    }catch(error){await admin.auth.admin.deleteUser(userId);throw error;}
  }catch{return json(req,{error:"Bootstrap failed"},400);}
});
