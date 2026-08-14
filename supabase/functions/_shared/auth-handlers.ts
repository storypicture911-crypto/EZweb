import { admin, audit, bodyOf, cors, derivePassword, edgeHandler, enforceRateLimit, generateCode, generateName, genericAuthError, hashSecurityValue, internalEmail, json, normalizeName, publicClient, recordSecurity, securityHashes, validGeneratedName, validPin, weakPin } from "./core.ts";

export async function createUser(req: Request) {
  return edgeHandler(req, async (body) => {
    const actor = body.__actor as {id:string;role:string}; const nickname = body.nickname ? String(body.nickname).trim().slice(0,30) : null;
    let generatedName=""; for(let attempt=0;attempt<8;attempt++){const candidate=generateName();const {data}=await admin.from("profiles").select("id").ilike("generated_name",candidate).maybeSingle();if(!data){generatedName=candidate;break;}}
    if(!generatedName) throw new Error("ID_GENERATION_FAILED");
    const userId=crypto.randomUUID(); const email=internalEmail(userId); const bootstrapPassword=`Bootstrap!${crypto.randomUUID()}${generateCode()}`;
    const {data:created,error:authError}=await admin.auth.admin.createUser({id:userId,email,password:bootstrapPassword,email_confirm:true,user_metadata:{managed_by:"ezwin"}});
    if(authError||!created.user) throw new Error("CREATE_FAILED");
    try{
      const code=generateCode(); const codeHash=await hashSecurityValue(`${userId}:${code}`); const expiresAt=new Date(Date.now()+7*86400_000).toISOString();
      const {error}=await admin.from("profiles").insert({id:userId,generated_name:generatedName,nickname,role:"user",created_by:actor.id}); if(error)throw error;
      await admin.from("auth_identities").insert({user_id:userId,internal_email:email});
      await admin.from("activation_codes").insert({user_id:userId,code_hash:codeHash,expires_at:expiresAt});
      await audit(admin,actor.id,"USER_CREATED","profile",userId,{role:"user"});
      return {generated_name:generatedName,one_time_code:code,expires_at:expiresAt};
    }catch(error){await admin.auth.admin.deleteUser(userId);throw error;}
  },["admin","staff"]);
}

export async function activateUser(req: Request) {
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(req)});
  let accountHash="",ipHash="";
  try{
    const body=await bodyOf(req);if(!body)throw new Error("INVALID"); const name=normalizeName(body.generated_name); const code=String(body.one_time_code||"").toUpperCase().trim();const pin=String(body.pin||"");const nickname=String(body.nickname||"").trim();
    if(!validGeneratedName(name)||!validPin(pin)||weakPin(pin)||nickname.length<1||nickname.length>30||!/^([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})$/.test(code))throw new Error("INVALID");
    ({accountHash,ipHash}=await enforceRateLimit(req,name));
    const {data:profile}=await admin.from("profiles").select("id,is_active").ilike("generated_name",name).maybeSingle(); if(!profile?.is_active)throw new Error("INVALID");
    const {data:activation}=await admin.from("activation_codes").select("*").eq("user_id",profile.id).is("used_at",null).order("created_at",{ascending:false}).limit(1).maybeSingle();
    if(!activation||new Date(activation.expires_at)<=new Date()||activation.locked_until&&new Date(activation.locked_until)>new Date())throw new Error("INVALID");
    const hash=await hashSecurityValue(`${profile.id}:${code}`); if(hash!==activation.code_hash){const attempts=activation.failed_attempts+1;await admin.from("activation_codes").update({failed_attempts:attempts,locked_until:attempts>=5?new Date(Date.now()+15*60_000).toISOString():null}).eq("id",activation.id);throw new Error("INVALID");}
    const {data:identity}=await admin.from("auth_identities").select("*").eq("user_id",profile.id).single();const password=await derivePassword(name,pin,identity.pin_version);
    const {error:updateError}=await admin.auth.admin.updateUserById(profile.id,{password});if(updateError)throw new Error("INVALID");
    const {data:session,error:signError}=await publicClient().auth.signInWithPassword({email:identity.internal_email,password});if(signError||!session.session)throw new Error("INVALID");
    await admin.from("activation_codes").update({used_at:new Date().toISOString()}).eq("id",activation.id).is("used_at",null);
    const {data:oldProfile}=await admin.from("profiles").select("nickname").eq("id",profile.id).single();await admin.from("profiles").update({nickname,nickname_updated_at:new Date().toISOString()}).eq("id",profile.id);if(oldProfile?.nickname!==nickname)await admin.from("nickname_history").insert({user_id:profile.id,old_nickname:oldProfile?.nickname||null,new_nickname:nickname});
    await recordSecurity(accountHash,ipHash,"ACTIVATION_SUCCESS");await audit(admin,profile.id,"USER_ACTIVATED","profile",profile.id);
    return json(req,{session:{access_token:session.session.access_token,refresh_token:session.session.refresh_token,expires_at:session.session.expires_at}},200);
  }catch{if(!accountHash){const hashes=await securityHashes(req,"invalid");accountHash=hashes.accountHash;ipHash=hashes.ipHash;}await recordSecurity(accountHash,ipHash,"ACTIVATION_FAILED");return genericAuthError(req,401);}
}

export async function loginUser(req: Request) {
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(req)});let accountHash="",ipHash="";
  try{const body=await bodyOf(req);if(!body)throw new Error("INVALID");const name=normalizeName(body.generated_name);const pin=String(body.pin||"");if(!validGeneratedName(name)||!validPin(pin))throw new Error("INVALID");({accountHash,ipHash}=await enforceRateLimit(req,name));
    const {data:profile}=await admin.from("profiles").select("id,is_active").ilike("generated_name",name).maybeSingle();if(!profile?.is_active)throw new Error("INVALID");const {data:identity}=await admin.from("auth_identities").select("*").eq("user_id",profile.id).single();if(!identity)throw new Error("INVALID");const password=await derivePassword(name,pin,identity.pin_version);
    const {data,error}=await publicClient().auth.signInWithPassword({email:identity.internal_email,password});if(error||!data.session)throw new Error("INVALID");await recordSecurity(accountHash,ipHash,"LOGIN_SUCCESS");return json(req,{session:{access_token:data.session.access_token,refresh_token:data.session.refresh_token,expires_at:data.session.expires_at}},200);
  }catch(error){if(!accountHash){const hashes=await securityHashes(req,"invalid");accountHash=hashes.accountHash;ipHash=hashes.ipHash;}await recordSecurity(accountHash,ipHash,error instanceof Error&&error.message==="RATE_LIMITED"?"LOGIN_LOCKED":"LOGIN_FAILED");return genericAuthError(req,error instanceof Error&&error.message==="RATE_LIMITED"?429:401);}
}

export async function changePin(req: Request){return edgeHandler(req,async(body)=>{const actor=body.__actor as {id:string;generated_name:string};const current=String(body.current_pin||"");const next=String(body.new_pin||"");if(!validPin(current)||!validPin(next)||weakPin(next)||current===next)throw new Error("INVALID_PIN");const {data:identity}=await admin.from("auth_identities").select("*").eq("user_id",actor.id).single();const currentPassword=await derivePassword(actor.generated_name,current,identity.pin_version);const {error}=await publicClient().auth.signInWithPassword({email:identity.internal_email,password:currentPassword});if(error)throw new Error("INVALID_PIN");const newVersion=identity.pin_version+1;const password=await derivePassword(actor.generated_name,next,newVersion);const {error:updateError}=await admin.auth.admin.updateUserById(actor.id,{password});if(updateError)throw updateError;await admin.from("auth_identities").update({pin_version:newVersion,updated_at:new Date().toISOString()}).eq("user_id",actor.id);await audit(admin,actor.id,"PIN_CHANGED","profile",actor.id);return{ok:true};},["admin","staff","user"])}
