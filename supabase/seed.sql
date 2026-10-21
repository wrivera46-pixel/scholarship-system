
insert into public.programs (id, code, name, max_gwa, min_units, max_failed, max_incomplete, max_dropped, deadline) values
  ('a0000000-0000-0000-0000-000000000001', 'EXC', 'Excellence Scholar', 2.00, 18, 0, 0, 0, '2026-11-06 17:00:00+08'),
  ('a0000000-0000-0000-0000-000000000002', 'ACC', 'Access Scholar',     2.50, 15, 0, 0, 1, '2026-11-06 17:00:00+08')
on conflict (id) do nothing;

insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('b0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b01@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Maria Santos","student_id":"2026-0001"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b02@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Juan Dela Cruz","student_id":"2026-0002"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b03@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Ana Lim","student_id":"2026-0003"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b04@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Carlo Reyes","student_id":"2026-0004"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b05@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Bea Villanueva","student_id":"2026-0005"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b06@seed.example.test', md5(random()::text), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Paolo Garcia","student_id":"2026-0006"}', now(), now())
on conflict (id) do nothing;

insert into public.scholar_assignments (scholar_id, program_id) values
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-000000000002')
on conflict (scholar_id) do nothing;

insert into public.submissions
  (id, scholar_id, academic_year, semester, gwa, enrolled_units, failed_count, incomplete_count, dropped_count,
   evidence_ref, submitted_at, verification_status, verified_at)
values
  ('c0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','2026-2027',1,2.00,18,0,0,0,'GRADEDOC-2026-B01','2026-11-06 17:00:00+08','Verified', now()),
  ('c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','2026-2027',1,2.01,18,0,0,0,'GRADEDOC-2026-B02','2026-11-05 17:00:00+08','Verified', now()),
  ('c0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000003','2026-2027',1,2.50,15,0,0,1,'GRADEDOC-2026-B03','2026-11-05 17:00:00+08','Verified', now()),
  ('c0000000-0000-0000-0000-000000000004','b0000000-0000-0000-0000-000000000004','2026-2027',1,2.50,14,0,1,0,'GRADEDOC-2026-B04','2026-11-05 17:00:00+08','Verified', now()),
  ('c0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000005','2026-2027',1,1.75,18,1,0,0,'GRADEDOC-2026-B05','2026-11-06 17:01:00+08','Verified', now()),
  ('c0000000-0000-0000-0000-000000000006','b0000000-0000-0000-0000-000000000006','2026-2027',1,2.25,15,0,0,0,'GRADEDOC-2026-B06','2026-11-05 17:00:00+08','Pending', null)
on conflict (id) do nothing;

insert into public.audit_log (submission_id, actor_name, actor_role, action, details)
select id, 'seed script', 'system', 'Seeded', 'Synthetic test record ' || evidence_ref
from public.submissions
where id::text like 'c0000000-%'
  and not exists (select 1 from public.audit_log l where l.submission_id = submissions.id and l.action = 'Seeded');
