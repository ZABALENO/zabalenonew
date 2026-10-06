-- Schéma PostgreSQL. Spouští se automaticky při startu serveru (idempotentní).
create table if not exists users(
  id serial primary key, email text unique not null, name text not null,
  role text not null check(role in('admin','partner')), password_hash text not null,
  created_at timestamptz not null default now());

create table if not exists products(
  id text primary key, name text not null,
  price numeric(12,2) not null check(price>=0), cost numeric(12,2) not null check(cost>=0),
  my_share numeric(5,2) not null, partner_share numeric(5,2) not null,
  category text not null default '', note text not null default '', active boolean not null default true,
  created_at timestamptz not null default now(),
  check(my_share>=0 and partner_share>=0 and my_share+partner_share=100));

create table if not exists product_variants(
  id serial primary key, product_id text not null references products(id) on delete cascade,
  pos int not null, name text not null, options text[] not null);

create table if not exists orders(
  id text primary key, num text unique not null, order_date date not null, due date,
  customer text not null, contact text not null default '', ship text not null default '', note text not null default '',
  status text not null default 'nova' check(status in('nova','vyroba','vyrobeno','pripraveno','predano','zruseno')),
  ts bigint not null, created_at timestamptz not null default now());

-- product_id: při smazání produktu zůstanou staré objednávky/prodeje (pname se uchová)
create table if not exists order_items(
  id serial primary key, order_id text not null references orders(id) on delete cascade, pos int not null,
  product_id text references products(id) on delete set null, pname text not null,
  qty int not null check(qty>0), price numeric(12,2) not null check(price>=0), cost numeric(12,2) not null check(cost>=0),
  my_share numeric(5,2) not null, partner_share numeric(5,2) not null, vars jsonb);

create table if not exists sales(
  id text primary key, order_id text references orders(id) on delete cascade, num text,
  sale_date date not null, ts bigint not null, created_at timestamptz not null default now());

create table if not exists sale_items(
  id serial primary key, sale_id text not null references sales(id) on delete cascade, pos int not null,
  product_id text references products(id) on delete set null, pname text not null,
  qty int not null check(qty>0), price numeric(12,2) not null check(price>=0), cost numeric(12,2) not null check(cost>=0),
  my_share numeric(5,2) not null, partner_share numeric(5,2) not null, vars jsonb);

create table if not exists production_tasks(
  id text primary key, order_id text not null unique references orders(id) on delete cascade,
  num text not null, customer text not null, due date, note text not null default '', items jsonb not null,
  status text not null default 'new' check(status in('new','read','progress','done')), ts bigint not null);

create table if not exists notifications(
  id text primary key, to_role text not null check(to_role in('admin','partner')),
  text text not null, ts bigint not null, read boolean not null default false);

create table if not exists settings(key text primary key, value jsonb not null);

create index if not exists i_oi on order_items(order_id);
create index if not exists i_si on sale_items(sale_id);
create index if not exists i_pv on product_variants(product_id);
create index if not exists i_o_date on orders(order_date);
create index if not exists i_s_date on sales(sale_date);
create index if not exists i_n on notifications(to_role,ts);
