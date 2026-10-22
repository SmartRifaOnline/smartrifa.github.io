# Smart Rifa Online

Sistema de rifas (pontos, pagamentos, bolões e sorteios) com login, acessos liberados pelo administrador e dados salvos automaticamente na nuvem.

Endereço: https://smartrifaonline.github.io

## Como funciona

- **Site**: GitHub Pages, publicado a partir deste repositório (ramo `main`).
- **Contas, dados e backups**: projeto `smart-rifa` no Supabase (região São Paulo).
  - `profiles`: quem pode entrar, com o perfil (`admin`, `vendedor`, `espelho` = somente leitura) e a situação (`pendente`, `ativo`, `bloqueado`).
  - `docs`: os dados do sistema. Um documento `geral` (ajustes, contatos, registro de atividades, licença), um `rifa:<id>` por rifa e um `capa:<id>` com a imagem de capa.
  - `backups`: cópia completa de hora em hora (últimas 24 horas) e uma por dia (último mês), feitas pelo `pg_cron`.
  - Função `acessos` (Edge Function): pedir acesso, e para o administrador criar acesso, trocar senha e excluir.
- **Segurança**: regras do banco (RLS) só deixam ler quem está ativo, só deixam alterar administradores e vendedores, e só o administrador altera acessos.
- **Várias pessoas ao mesmo tempo**: cada alteração é enviada na hora. Se duas pessoas salvarem a mesma rifa juntas, as duas versões são juntadas (`nuvem.js`). Sem internet, o sistema continua funcionando e envia tudo quando a conexão volta.

## Arquivos

- `index.html`: o sistema (tela, rifas, relatórios).
- `nuvem.js`: login, acessos e sincronização com a nuvem.
- `supabase.js`: biblioteca do Supabase (v2.45.4), guardada aqui para o app abrir sem internet.
- `sw.js`: funcionamento offline. Ao publicar mudanças, aumente a versão em `VERSAO`.
- `supabase/`: SQL do banco e código da função `acessos`, para referência.
