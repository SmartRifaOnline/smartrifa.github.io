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
