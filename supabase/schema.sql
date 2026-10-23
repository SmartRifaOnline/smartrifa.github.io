-- Banco do Smart Rifa Online (projeto Supabase "smart-rifa"). Referência do que está aplicado.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nome text not null default '',
  tel text not null default '',
  role text not null default 'vendedor' check (role in ('admin','vendedor','espelho')),
  status text not null default 'pendente' check (status in ('pendente','ativo','bloqueado')),
  criado_em timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.meu_perfil_ativo() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo');
$$;
create or replace function public.sou_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and role = 'admin');
$$;
create or replace function public.posso_editar() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and role in ('admin','vendedor'));
$$;
revoke execute on function public.meu_perfil_ativo(), public.sou_admin(), public.posso_editar() from anon, public;
grant execute on function public.meu_perfil_ativo(), public.sou_admin(), public.posso_editar() to authenticated;

create policy "ver o proprio perfil ou admin ve todos" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.sou_admin()));
create policy "admin altera perfis" on public.profiles for update to authenticated
  using ((select public.sou_admin())) with check ((select public.sou_admin()));

-- conta nova nasce aguardando liberação; o e-mail do dono nasce administrador ativo
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = '' as $$
declare dono boolean;
begin
  dono := lower(new.email) = 'alberths177@gmail.com';
  insert into public.profiles(id, email, nome, role, status)
  values (new.id, lower(new.email), coalesce(nullif(new.raw_user_meta_data->>'nome',''), split_part(new.email,'@',1)),
          case when dono then 'admin' else 'vendedor' end,
          case when dono then 'ativo' else 'pendente' end);
  return new;
end $$;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

create or replace function public.protege_ultimo_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and old.status = 'ativo' and (new.role <> 'admin' or new.status <> 'ativo')
     and not exists(select 1 from public.profiles where role='admin' and status='ativo' and id <> old.id) then
    raise exception 'Precisa existir ao menos um administrador ativo.';
  end if;
  return new;
end $$;
create trigger protege_admin before update on public.profiles
  for each row execute function public.protege_ultimo_admin();

create table public.docs (
  id text primary key,
  data jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.docs enable row level security;
create policy "ativos leem" on public.docs for select to authenticated using ((select public.meu_perfil_ativo()));
create policy "editores criam" on public.docs for insert to authenticated with check ((select public.posso_editar()));
create policy "editores alteram" on public.docs for update to authenticated using ((select public.posso_editar())) with check ((select public.posso_editar()));
-- rifas excluídas viram {"_apagada":true}; não há exclusão de linhas pelo app

create or replace function public.docs_carimbo() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger docs_carimbo before insert or update on public.docs
  for each row execute function public.docs_carimbo();
alter publication supabase_realtime add table public.docs;

create table public.backups (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('hora','dia')),
  criado_em timestamptz not null default now(),
  dados jsonb not null,
  slot text unique
);
alter table public.backups enable row level security;
create policy "admin le backups" on public.backups for select to authenticated using ((select public.sou_admin()));

-- cada cópia ocupa uma "vaga" (hora-00..23, dia-01..31) e substitui a anterior da mesma vaga
create or replace function public.faz_backup(p_tipo text) returns void
language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  if not exists(select 1 from public.docs) then return; end if;
  s := case when p_tipo = 'hora' then 'hora-' || to_char(now() at time zone 'America/Sao_Paulo', 'HH24')
            else 'dia-' || to_char(now() at time zone 'America/Sao_Paulo', 'DD') end;
  insert into public.backups(slot, tipo, criado_em, dados)
  select s, p_tipo, now(), jsonb_object_agg(id, data) from public.docs
  on conflict (slot) do update set criado_em = excluded.criado_em, dados = excluded.dados, tipo = excluded.tipo;
end $$;
revoke execute on function public.faz_backup(text) from anon, authenticated, public;

create extension if not exists pg_cron;
select cron.schedule('backup-por-hora', '0 * * * *', $$select public.faz_backup('hora')$$);
select cron.schedule('backup-diario', '0 6 * * *', $$select public.faz_backup('dia')$$);

-- funções de gatilho não ficam disponíveis pela API
revoke execute on function public.novo_usuario(), public.protege_ultimo_admin(), public.docs_carimbo() from anon, authenticated, public;

-- 22/10/2026: só o dono do sistema cuida dos acessos
alter table public.profiles add column dono boolean not null default false;
update public.profiles set dono = true where email = 'alberths177@gmail.com';
create or replace function public.sou_dono() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and dono);
$$;
revoke execute on function public.sou_dono() from anon, public;
grant execute on function public.sou_dono() to authenticated;
alter policy "ver o proprio perfil ou admin ve todos" on public.profiles using (id = (select auth.uid()) or (select public.sou_dono()));
alter policy "ver o proprio perfil ou admin ve todos" on public.profiles rename to "ver o proprio perfil ou o dono ve todos";
alter policy "admin altera perfis" on public.profiles using ((select public.sou_dono())) with check ((select public.sou_dono()));
alter policy "admin altera perfis" on public.profiles rename to "so o dono altera perfis";
-- novo_usuario() passa a gravar dono = (e-mail do dono) e protege_ultimo_admin() impede
-- alterar o acesso do dono ou tornar outra conta dona.

-- 23/10/2026: clientes e membros (cada cliente tem os próprios dados)
-- "projeto" separa os dados. 'principal' = projeto do dono do sistema.
-- Cliente = role admin com projeto = o próprio id. Membro = role vendedor com projeto = id do cliente.
-- Na tabela docs, os documentos de um cliente se chamam "<projeto>/<documento>"; os do principal não mudaram.
alter table public.profiles add column if not exists projeto text not null default 'principal';
alter table public.docs add column if not exists projeto text not null default 'principal';
alter table public.backups add column if not exists projeto text not null default 'principal';
create index if not exists docs_projeto on public.docs(projeto);
create index if not exists profiles_projeto on public.profiles(projeto);

create or replace function public.meu_projeto() returns text
language sql stable security definer set search_path = '' as $$
  select p.projeto from public.profiles p
  where p.id = auth.uid() and p.status = 'ativo'
    and (p.projeto = 'principal' or exists(select 1 from public.profiles c where c.id::text = p.projeto and c.status = 'ativo' and c.role = 'admin'));
$$;
create or replace function public.posso_editar() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and role in ('admin','vendedor')) and public.meu_projeto() is not null;
$$;
create or replace function public.sou_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and role = 'admin') and public.meu_projeto() is not null;
$$;
create or replace function public.sou_cliente() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'ativo' and role = 'admin' and projeto = id::text);
$$;
revoke execute on function public.meu_projeto(), public.sou_cliente() from anon, public;
grant execute on function public.meu_projeto(), public.sou_cliente() to authenticated;

alter policy "ver o proprio perfil ou o dono ve todos" on public.profiles
  using (id = (select auth.uid()) or (select public.sou_dono()) or ((select public.sou_cliente()) and projeto = (select public.meu_projeto())));
alter policy "ativos leem" on public.docs using (projeto = (select public.meu_projeto()));
alter policy "editores criam" on public.docs with check (
  (select public.posso_editar()) and projeto = (select public.meu_projeto())
  and ((projeto = 'principal' and position('/' in id) = 0) or id like projeto || '/%'));
alter policy "editores alteram" on public.docs
  using ((select public.posso_editar()) and projeto = (select public.meu_projeto()))
  with check ((select public.posso_editar()) and projeto = (select public.meu_projeto()));
alter policy "admin le backups" on public.backups using ((select public.sou_admin()) and projeto = (select public.meu_projeto()));

create or replace function public.docs_carimbo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now(); new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.projeto := coalesce(public.meu_projeto(), new.projeto); end if;
  else
    new.projeto := old.projeto; new.id := old.id;
  end if;
  return new;
end $$;

-- uma cópia por projeto em cada vaga (as do principal mantêm os nomes antigos)
create or replace function public.faz_backup(p_tipo text) returns void
language plpgsql security definer set search_path = '' as $$
declare s text; pj text;
begin
  s := case when p_tipo = 'hora' then 'hora-' || to_char(now() at time zone 'America/Sao_Paulo', 'HH24')
            else 'dia-' || to_char(now() at time zone 'America/Sao_Paulo', 'DD') end;
  for pj in select distinct projeto from public.docs loop
    insert into public.backups(slot, tipo, criado_em, dados, projeto)
    select case when pj = 'principal' then s else pj || ':' || s end, p_tipo, now(),
           jsonb_object_agg(case when pj = 'principal' then id else substr(id, length(pj) + 2) end, data), pj
    from public.docs where projeto = pj
    on conflict (slot) do update set criado_em = excluded.criado_em, dados = excluded.dados, tipo = excluded.tipo;
  end loop;
end $$;

-- cliente é sempre admin do próprio projeto; membro é sempre vendedor do projeto do cliente
create or replace function public.protege_ultimo_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.dono and (new.role <> 'admin' or new.status <> 'ativo' or not new.dono or new.projeto <> 'principal') then
    raise exception 'O acesso do dono não pode ser alterado.';
  end if;
  if new.dono and not old.dono then
    raise exception 'Não é possível tornar outra conta dona do sistema.';
  end if;
  if new.projeto = new.id::text then new.role := 'admin';
  elsif new.projeto <> 'principal' then
    new.role := 'vendedor';
    if not exists(select 1 from public.profiles c where c.id::text = new.projeto and c.projeto = c.id::text) then
      raise exception 'Cliente inválido.';
    end if;
  end if;
  if old.projeto = 'principal' and old.role = 'admin' and old.status = 'ativo'
     and (new.role <> 'admin' or new.status <> 'ativo' or new.projeto <> 'principal')
     and not exists(select 1 from public.profiles where role='admin' and status='ativo' and projeto='principal' and id <> old.id) then
    raise exception 'Precisa existir ao menos um administrador ativo.';
  end if;
  return new;
end $$;
revoke execute on function public.docs_carimbo(), public.faz_backup(text), public.protege_ultimo_admin() from anon, authenticated, public;
