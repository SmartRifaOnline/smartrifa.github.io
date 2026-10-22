import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const adm = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ROLES = ["admin", "vendedor", "espelho"];
const emailOk = (e: unknown) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const senhaOk = (s: unknown) => typeof s === "string" && s.length >= 6;

function traduz(msg: string) {
  if (/already|registered|exists/i.test(msg)) return "Já existe uma conta com esse e-mail.";
  if (/password/i.test(msg)) return "Senha fraca: use pelo menos 6 caracteres.";
  return msg;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resp({ erro: "Método inválido." }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return resp({ erro: "Pedido inválido." }, 400); }
  const acao = b.acao;

  // pedido de acesso: qualquer pessoa pode pedir; a conta fica aguardando liberação
  if (acao === "pedir") {
    if (!emailOk(b.email)) return resp({ erro: "Informe um e-mail válido." }, 400);
    if (!senhaOk(b.senha)) return resp({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
    const nome = String(b.nome || "").trim().slice(0, 80);
    if (!nome) return resp({ erro: "Informe o seu nome." }, 400);
    const { error } = await adm.auth.admin.createUser({
      email: String(b.email).trim().toLowerCase(), password: String(b.senha), email_confirm: true, user_metadata: { nome },
    });
    if (error) return resp({ erro: traduz(error.message) }, 400);
    return resp({ ok: true });
  }

  // demais ações: só o dono do sistema (quem libera os acessos)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await adm.auth.getUser(token);
  if (!u?.user) return resp({ erro: "Entre novamente no sistema." }, 401);
  const { data: eu } = await adm.from("profiles").select("status,dono").eq("id", u.user.id).single();
  if (!eu || !eu.dono || eu.status !== "ativo") return resp({ erro: "Só o dono do sistema pode cuidar dos acessos." }, 403);

  if (acao === "criar") {
    if (!emailOk(b.email)) return resp({ erro: "Informe um e-mail válido." }, 400);
    if (!senhaOk(b.senha)) return resp({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
    const role = ROLES.includes(String(b.role)) ? String(b.role) : "vendedor";
    const nome = String(b.nome || "").trim().slice(0, 80);
    const { data, error } = await adm.auth.admin.createUser({
      email: String(b.email).trim().toLowerCase(), password: String(b.senha), email_confirm: true, user_metadata: { nome },
    });
    if (error || !data.user) return resp({ erro: traduz(error?.message || "Não foi possível criar.") }, 400);
    const { error: e2 } = await adm.from("profiles").update({ role, status: "ativo", nome: nome || undefined, tel: String(b.tel || "").slice(0, 30) }).eq("id", data.user.id);
    if (e2) return resp({ erro: e2.message }, 400);
    return resp({ ok: true, id: data.user.id });
  }

  if (acao === "senha") {
    if (typeof b.id !== "string") return resp({ erro: "Usuário inválido." }, 400);
    if (!senhaOk(b.senha)) return resp({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
    const { error } = await adm.auth.admin.updateUserById(b.id, { password: String(b.senha) });
    if (error) return resp({ erro: traduz(error.message) }, 400);
    return resp({ ok: true });
  }

  if (acao === "excluir") {
    if (typeof b.id !== "string") return resp({ erro: "Usuário inválido." }, 400);
    if (b.id === u.user.id) return resp({ erro: "Você não pode excluir o próprio acesso." }, 400);
    const { data: alvo } = await adm.from("profiles").select("role,status,dono").eq("id", b.id).single();
    if (alvo?.dono) return resp({ erro: "O acesso do dono não pode ser excluído." }, 400);
    if (alvo?.role === "admin" && alvo?.status === "ativo") {
      const { count } = await adm.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin").eq("status", "ativo");
      if ((count || 0) <= 1) return resp({ erro: "Precisa existir ao menos um administrador ativo." }, 400);
    }
    const { error } = await adm.auth.admin.deleteUser(b.id);
    if (error) return resp({ erro: error.message }, 400);
    return resp({ ok: true });
  }

  return resp({ erro: "Ação desconhecida." }, 400);
});
