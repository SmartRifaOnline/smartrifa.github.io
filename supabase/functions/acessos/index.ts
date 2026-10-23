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

  // demais ações: o dono do sistema cuida de todos os acessos; o cliente cuida só dos membros dele
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await adm.auth.getUser(token);
  if (!u?.user) return resp({ erro: "Entre novamente no sistema." }, 401);
  const { data: eu } = await adm.from("profiles").select("status,dono,role,projeto").eq("id", u.user.id).single();
  const dono = !!eu && eu.dono && eu.status === "ativo";
  const cliente = !!eu && !eu.dono && eu.status === "ativo" && eu.role === "admin" && eu.projeto === u.user.id;
  if (!dono && !cliente) return resp({ erro: "Só o dono do sistema pode cuidar dos acessos." }, 403);

  // o cliente só mexe nos membros do próprio projeto
  async function alvoOk(id: unknown) {
    if (typeof id !== "string") return "Usuário inválido.";
    if (id === u!.user!.id) return "Você não pode alterar o próprio acesso por aqui.";
    const { data: alvo } = await adm.from("profiles").select("role,status,dono,projeto").eq("id", id).single();
    if (!alvo) return "Usuário não encontrado.";
    if (alvo.dono) return "O acesso do dono não pode ser alterado.";
    if (cliente && alvo.projeto !== eu!.projeto) return "Esse acesso não é da sua equipe.";
    return "";
  }

  if (acao === "criar") {
    if (!emailOk(b.email)) return resp({ erro: "Informe um e-mail válido." }, 400);
    if (!senhaOk(b.senha)) return resp({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
    const nome = String(b.nome || "").trim().slice(0, 80);
    if (!nome) return resp({ erro: "Informe o nome." }, 400);
    const { data, error } = await adm.auth.admin.createUser({
      email: String(b.email).trim().toLowerCase(), password: String(b.senha), email_confirm: true, user_metadata: { nome },
    });
    if (error || !data.user) return resp({ erro: traduz(error?.message || "Não foi possível criar.") }, 400);
    let campos: Record<string, unknown>;
    if (cliente) campos = { role: "vendedor", projeto: eu!.projeto };
    else if (b.role === "cliente") campos = { role: "admin", projeto: data.user.id };
    else campos = { role: ROLES.includes(String(b.role)) ? String(b.role) : "vendedor", projeto: "principal" };
    const { error: e2 } = await adm.from("profiles").update({ ...campos, status: "ativo", nome, tel: String(b.tel || "").slice(0, 30) }).eq("id", data.user.id);
    if (e2) { await adm.auth.admin.deleteUser(data.user.id); return resp({ erro: e2.message }, 400); }
    return resp({ ok: true, id: data.user.id });
  }

  if (acao === "status") {
    const m = await alvoOk(b.id); if (m) return resp({ erro: m }, 400);
    const status = b.status === "ativo" ? "ativo" : "bloqueado";
    const { error } = await adm.from("profiles").update({ status }).eq("id", String(b.id));
    if (error) return resp({ erro: error.message }, 400);
    return resp({ ok: true });
  }

  if (acao === "senha") {
    const m = await alvoOk(b.id); if (m) return resp({ erro: m }, 400);
    if (!senhaOk(b.senha)) return resp({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
    const { error } = await adm.auth.admin.updateUserById(String(b.id), { password: String(b.senha) });
    if (error) return resp({ erro: traduz(error.message) }, 400);
    return resp({ ok: true });
  }

  if (acao === "excluir") {
    const m = await alvoOk(b.id); if (m) return resp({ erro: m }, 400);
    const { data: alvo } = await adm.from("profiles").select("role,status,projeto").eq("id", String(b.id)).single();
    if (alvo?.role === "admin" && alvo?.status === "ativo" && alvo?.projeto === "principal") {
      const { count } = await adm.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin").eq("status", "ativo").eq("projeto", "principal");
      if ((count || 0) <= 1) return resp({ erro: "Precisa existir ao menos um administrador ativo." }, 400);
    }
    const { error } = await adm.auth.admin.deleteUser(String(b.id));
    if (error) return resp({ erro: error.message }, 400);
    return resp({ ok: true });
  }

  return resp({ erro: "Ação desconhecida." }, 400);
});
