create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text not null,
  student_id  text unique,
  role        text not null default 'scholar' check (role in ('scholar','staff')),
  created_at  timestamptz not null default now()
);

create table public.programs (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  max_gwa         numeric(3,2) not null check (max_gwa between 1 and 5),
  min_units       int not null check (min_units >= 0),
  max_failed      int not null check (max_failed >= 0),
  max_incomplete  int not null check (max_incomplete >= 0),
  max_dropped     int not null check (max_dropped >= 0),
  deadline        timestamptz not null
);

create table public.scholar_assignments (
  id           uuid primary key default gen_random_uuid(),
  scholar_id   uuid not null unique references public.profiles(id) on delete cascade,
  program_id   uuid not null references public.programs(id),
  award_status text not null default 'Active' check (award_status in ('Active','Suspended','Terminated')),
  assigned_by  uuid references public.profiles(id),
  assigned_at  timestamptz not null default now()
);

create table public.submissions (
  id                  uuid primary key default gen_random_uuid(),
  scholar_id          uuid not null references public.profiles(id) on delete cascade,
  academic_year       text not null check (academic_year ~ '^[0-9]{4}-[0-9]{4}$'),
  semester            int  not null check (semester in (1,2,3)),
  gwa                 numeric(3,2) not null check (gwa between 1 and 5),
  enrolled_units      int not null check (enrolled_units >= 0),
  failed_count        int not null check (failed_count >= 0),
  incomplete_count    int not null check (incomplete_count >= 0),
  dropped_count       int not null check (dropped_count >= 0),
  evidence_ref        text not null check (btrim(evidence_ref) <> ''),
  submitted_at        timestamptz not null default now(),
  last_resubmitted_at timestamptz,
  -- three separate status dimensions
  verification_status text not null default 'Pending' check (verification_status in ('Pending','Verified','Returned')),
  verification_reason text,
  verified_by         uuid references public.profiles(id),
  verified_at         timestamptz,
  compliance_result   text not null default 'Not Evaluated' check (compliance_result in ('Not Evaluated','Compliant','With Deficiency')),
  evaluation_checks   jsonb,
  deficiency_reasons  text[],
  is_late             boolean,
  evaluated_by        uuid references public.profiles(id),
  evaluated_at        timestamptz,
  renewal_decision    text not null default 'None' check (renewal_decision in ('None','Approved','Held')),
  decision_note       text,
  decided_by          uuid references public.profiles(id),
  decided_at          timestamptz,
  constraint uq_scholar_term unique (scholar_id, academic_year, semester)
);

create table public.audit_log (
  id            bigint generated always as identity primary key,
  submission_id uuid references public.submissions(id) on delete cascade,
  actor_id      uuid references public.profiles(id),
  actor_name    text,
  actor_role    text,
  action        text not null,
  details       text,
  created_at    timestamptz not null default now()
);

create index on public.submissions (academic_year, semester);
create index on public.audit_log (submission_id, created_at);

create view public.submission_details with (security_invoker = true) as
select s.*,
       p.full_name,
       p.student_id,
       a.award_status,
       g.id   as program_id,
       g.code as program_code,
       g.name as program_name
from public.submissions s
join public.profiles p on p.id = s.scholar_id
left join public.scholar_assignments a on a.scholar_id = s.scholar_id
left join public.programs g on g.id = a.program_id;

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, student_id, role)
  values (new.id,
          new.email,
          coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), new.email),
          nullif(btrim(new.raw_user_meta_data->>'student_id'), ''),
          'scholar');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'staff');
$$;

create function public._require_staff() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.is_staff() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
end $$;

create function public._log(p_sub uuid, p_action text, p_details text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_role text;
begin
  select full_name, role into v_name, v_role from public.profiles where id = auth.uid();
  insert into public.audit_log (submission_id, actor_id, actor_name, actor_role, action, details)
  values (p_sub, auth.uid(), coalesce(v_name, 'system'), coalesce(v_role, 'system'), p_action, p_details);
end $$;

create function public._validate_summary(
  p_gwa numeric, p_units int, p_failed int, p_inc int, p_drop int, p_evidence text
) returns void language plpgsql immutable as $$
begin
  if p_gwa is null or p_gwa < 1.00 or p_gwa > 5.00 then
    raise exception 'GWA must be between 1.00 and 5.00 (got %)', coalesce(p_gwa::text, 'blank');
  end if;
  if p_gwa <> round(p_gwa, 2) then
    raise exception 'GWA may have at most 2 decimal places';
  end if;
  if p_units  is null or p_units  < 0 then raise exception 'Enrolled units must be a non-negative whole number'; end if;
  if p_failed is null or p_failed < 0 then raise exception 'Failed subject count must be a non-negative whole number'; end if;
  if p_inc    is null or p_inc    < 0 then raise exception 'Incomplete grade count must be a non-negative whole number'; end if;
  if p_drop   is null or p_drop   < 0 then raise exception 'Dropped subject count must be a non-negative whole number'; end if;
  if p_evidence is null or btrim(p_evidence) = '' then
    raise exception 'A grade-document reference is required';
  end if;
  if length(p_evidence) > 300 then
    raise exception 'Grade-document reference is too long (max 300 characters)';
  end if;
end $$;

create function public.submit_grades(
  p_year text, p_sem int, p_gwa numeric, p_units int,
  p_failed int, p_inc int, p_drop int, p_evidence text
) returns public.submissions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.submissions;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and role = 'scholar') then
    raise exception 'Only scholars can submit semester grades' using errcode = '42501';
  end if;
  if not exists (select 1 from public.scholar_assignments where scholar_id = v_uid) then
    raise exception 'You are not assigned to a scholarship program yet. Please contact the Scholarship Office.';
  end if;
  if p_year is null or p_year !~ '^[0-9]{4}-[0-9]{4}$'
     or substr(p_year, 6, 4)::int <> substr(p_year, 1, 4)::int + 1 then
    raise exception 'Academic year must be two consecutive years, e.g. 2026-2027';
  end if;
  if p_sem is null or p_sem not in (1, 2, 3) then
    raise exception 'Semester must be 1, 2 or 3 (Summer)';
  end if;
  perform public._validate_summary(p_gwa, p_units, p_failed, p_inc, p_drop, p_evidence);

  if exists (select 1 from public.submissions
             where scholar_id = v_uid and academic_year = p_year and semester = p_sem) then
    raise exception 'A submission for AY % semester % already exists. Duplicate semester entries are not allowed.', p_year, p_sem;
  end if;

  insert into public.submissions
    (scholar_id, academic_year, semester, gwa, enrolled_units, failed_count,
     incomplete_count, dropped_count, evidence_ref, submitted_at)
  values (v_uid, p_year, p_sem, p_gwa, p_units, p_failed, p_inc, p_drop, btrim(p_evidence), now())
  returning * into v_row;

  perform public._log(v_row.id, 'Submitted',
    format('AY %s sem %s, GWA %s, units %s', p_year, p_sem, p_gwa, p_units));
  return v_row;
exception when unique_violation then
  raise exception 'A submission for AY % semester % already exists. Duplicate semester entries are not allowed.', p_year, p_sem;
end $$;

create function public.resubmit_grades(
  p_id uuid, p_gwa numeric, p_units int, p_failed int, p_inc int, p_drop int, p_evidence text
) returns public.submissions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.submissions;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_row from public.submissions where id = p_id and scholar_id = v_uid for update;
  if not found then
    raise exception 'Submission not found' using errcode = '42501';
  end if;
  if v_row.verification_status <> 'Returned' then
    raise exception 'Only a Returned submission can be corrected (current status: %)', v_row.verification_status;
  end if;
  perform public._validate_summary(p_gwa, p_units, p_failed, p_inc, p_drop, p_evidence);

  -- Correction returns the record to Pending verification and clears every downstream result.
  -- submitted_at (the original receipt time used for the deadline test) is preserved.
  update public.submissions set
    gwa = p_gwa, enrolled_units = p_units, failed_count = p_failed,
    incomplete_count = p_inc, dropped_count = p_drop, evidence_ref = btrim(p_evidence),
    last_resubmitted_at = now(),
    verification_status = 'Pending', verification_reason = null, verified_by = null, verified_at = null,
    compliance_result = 'Not Evaluated', evaluation_checks = null, deficiency_reasons = null,
    is_late = null, evaluated_by = null, evaluated_at = null,
    renewal_decision = 'None', decision_note = null, decided_by = null, decided_at = null
  where id = p_id
  returning * into v_row;

  perform public._log(p_id, 'Resubmitted', 'Corrected submission returned to Pending verification');
  return v_row;
end $$;

create function public.assign_scholar(p_scholar_id uuid, p_program_id uuid)
returns public.scholar_assignments
language plpgsql security definer set search_path = public as $$
declare
  v_row public.scholar_assignments;
  v_prog text;
  v_name text;
begin
  perform public._require_staff();
  select full_name into v_name from public.profiles where id = p_scholar_id and role = 'scholar';
  if not found then raise exception 'Scholar profile not found'; end if;
  select name into v_prog from public.programs where id = p_program_id;
  if not found then raise exception 'Program not found'; end if;

  insert into public.scholar_assignments (scholar_id, program_id, assigned_by)
  values (p_scholar_id, p_program_id, auth.uid())
  on conflict (scholar_id) do update
    set program_id = excluded.program_id, assigned_by = excluded.assigned_by, assigned_at = now()
  returning * into v_row;

  perform public._log(null, 'Program assigned', format('%s -> %s', v_name, v_prog));
  return v_row;
end $$;

create function public.verify_submission(p_id uuid, p_status text, p_reason text default null)
returns public.submissions
language plpgsql security definer set search_path = public as $$
declare v_row public.submissions;
begin
  perform public._require_staff();
  if p_status not in ('Verified', 'Returned') then
    raise exception 'Status must be Verified or Returned';
  end if;
  select * into v_row from public.submissions where id = p_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if v_row.verification_status <> 'Pending' then
    raise exception 'Only Pending submissions can be verified or returned (current status: %)', v_row.verification_status;
  end if;
  if p_status = 'Returned' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required when returning a submission';
  end if;

  update public.submissions set
    verification_status = p_status,
    verification_reason = nullif(btrim(coalesce(p_reason, '')), ''),
    verified_by = auth.uid(), verified_at = now()
  where id = p_id returning * into v_row;

  perform public._log(p_id, 'Verification: ' || p_status, p_reason);
  return v_row;
end $$;

create function public.evaluate_submission(p_id uuid)
returns public.submissions
language plpgsql security definer set search_path = public as $$
declare
  s public.submissions;
  pr public.programs;
  v_checks jsonb := '[]'::jsonb;
  v_reasons text[] := '{}';
  v_late boolean;
  v_result text;
  v_fmt constant text := 'YYYY-MM-DD HH24:MI';
begin
  perform public._require_staff();
  select * into s from public.submissions where id = p_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if s.verification_status <> 'Verified' then
    raise exception 'Cannot evaluate: evidence is % (it must be Verified first)', s.verification_status;
  end if;
  if s.evidence_ref is null or btrim(s.evidence_ref) = '' then
    raise exception 'Cannot evaluate: grade-document reference is missing';
  end if;
  if s.renewal_decision = 'Approved' then
    raise exception 'Renewal is already Approved; evaluation is locked';
  end if;

  select g.* into pr
  from public.scholar_assignments a join public.programs g on g.id = a.program_id
  where a.scholar_id = s.scholar_id;
  if not found then raise exception 'Scholar has no assigned program'; end if;

  v_checks := v_checks || jsonb_build_object('check','GWA (lower is better)','rule','<= ' || pr.max_gwa,
              'actual', to_char(s.gwa, 'FM0.00'), 'pass', s.gwa <= pr.max_gwa);
  if s.gwa > pr.max_gwa then
    v_reasons := v_reasons || format('GWA %s is above the maximum of %s', to_char(s.gwa,'FM0.00'), pr.max_gwa);
  end if;

  v_checks := v_checks || jsonb_build_object('check','Enrolled units','rule','>= ' || pr.min_units,
              'actual', s.enrolled_units::text, 'pass', s.enrolled_units >= pr.min_units);
  if s.enrolled_units < pr.min_units then
    v_reasons := v_reasons || format('Enrolled units %s are below the minimum of %s', s.enrolled_units, pr.min_units);
  end if;

  v_checks := v_checks || jsonb_build_object('check','Failed subjects','rule','<= ' || pr.max_failed,
              'actual', s.failed_count::text, 'pass', s.failed_count <= pr.max_failed);
  if s.failed_count > pr.max_failed then
    v_reasons := v_reasons || format('Failed subjects %s exceed the allowed %s', s.failed_count, pr.max_failed);
  end if;

  v_checks := v_checks || jsonb_build_object('check','Incomplete grades','rule','<= ' || pr.max_incomplete,
              'actual', s.incomplete_count::text, 'pass', s.incomplete_count <= pr.max_incomplete);
  if s.incomplete_count > pr.max_incomplete then
    v_reasons := v_reasons || format('Incomplete grades %s exceed the allowed %s', s.incomplete_count, pr.max_incomplete);
  end if;

  v_checks := v_checks || jsonb_build_object('check','Dropped subjects','rule','<= ' || pr.max_dropped,
              'actual', s.dropped_count::text, 'pass', s.dropped_count <= pr.max_dropped);
  if s.dropped_count > pr.max_dropped then
    v_reasons := v_reasons || format('Dropped subjects %s exceed the allowed %s', s.dropped_count, pr.max_dropped);
  end if;

  v_checks := v_checks || jsonb_build_object('check','Evidence reference','rule','present',
              'actual', 'present', 'pass', true);

  v_late := s.submitted_at > pr.deadline;
  v_checks := v_checks || jsonb_build_object('check','Submission deadline',
              'rule', '<= ' || to_char(pr.deadline at time zone 'Asia/Manila', v_fmt) || ' (Asia/Manila)',
              'actual', to_char(s.submitted_at at time zone 'Asia/Manila', v_fmt), 'pass', not v_late);
  if v_late then
    v_reasons := v_reasons || format('Late submission: received %s, deadline %s (Asia/Manila)',
      to_char(s.submitted_at at time zone 'Asia/Manila', v_fmt),
      to_char(pr.deadline at time zone 'Asia/Manila', v_fmt));
  end if;

  v_result := case when cardinality(v_reasons) = 0 then 'Compliant' else 'With Deficiency' end;

  update public.submissions set
    compliance_result = v_result, evaluation_checks = v_checks,
    deficiency_reasons = v_reasons, is_late = v_late,
    evaluated_by = auth.uid(), evaluated_at = now()
  where id = p_id returning * into s;

  perform public._log(p_id, 'Evaluation: ' || v_result,
    case when cardinality(v_reasons) = 0 then 'All policy checks passed' else array_to_string(v_reasons, '; ') end);
  return s;
end $$;

create function public.decide_renewal(p_id uuid, p_decision text, p_note text default null)
returns public.submissions
language plpgsql security definer set search_path = public as $$
declare s public.submissions;
begin
  perform public._require_staff();
  if p_decision not in ('Approved', 'Held') then
    raise exception 'Decision must be Approved or Held';
  end if;
  select * into s from public.submissions where id = p_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if s.verification_status <> 'Verified' then
    raise exception 'Cannot decide renewal: evidence is % (it must be Verified first)', s.verification_status;
  end if;
  if s.compliance_result = 'Not Evaluated' then
    raise exception 'Cannot decide renewal: the submission has not been evaluated yet';
  end if;
  if p_decision = 'Approved' and s.compliance_result <> 'Compliant' then
    raise exception 'Cannot approve renewal: this record is With Deficiency. Hold it instead.';
  end if;
  if p_decision = 'Held' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A decision note is required when holding renewal';
  end if;

  update public.submissions set
    renewal_decision = p_decision, decision_note = nullif(btrim(coalesce(p_note, '')), ''),
    decided_by = auth.uid(), decided_at = now()
  where id = p_id returning * into s;

  perform public._log(p_id, 'Renewal: ' || p_decision, p_note);
  return s;
end $$;

create function public.dashboard_stats(p_year text, p_sem int) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_staff();
  return json_build_object(
    'total_assigned', (select count(*) from public.scholar_assignments),
    'pending',   (select count(*) from public.submissions where academic_year = p_year and semester = p_sem and verification_status = 'Pending'),
    'compliant', (select count(*) from public.submissions where academic_year = p_year and semester = p_sem and compliance_result = 'Compliant'),
    'deficiency',(select count(*) from public.submissions where academic_year = p_year and semester = p_sem and compliance_result = 'With Deficiency')
  );
end $$;

alter table public.profiles            enable row level security;
alter table public.programs            enable row level security;
alter table public.scholar_assignments enable row level security;
alter table public.submissions         enable row level security;
alter table public.audit_log           enable row level security;

create policy profiles_read on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_staff());

create policy programs_read on public.programs
  for select to authenticated using (true);

create policy assignments_read on public.scholar_assignments
  for select to authenticated using (scholar_id = auth.uid() or public.is_staff());

create policy submissions_read on public.submissions
  for select to authenticated using (scholar_id = auth.uid() or public.is_staff());

create policy audit_read on public.audit_log
  for select to authenticated using (
    public.is_staff()
    or submission_id in (select id from public.submissions where scholar_id = auth.uid())
  );


grant usage on schema public to anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.programs, public.scholar_assignments,
                public.submissions, public.audit_log, public.submission_details to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_staff(),
  public.submit_grades(text,int,numeric,int,int,int,int,text),
  public.resubmit_grades(uuid,numeric,int,int,int,int,text),
  public.assign_scholar(uuid,uuid),
  public.verify_submission(uuid,text,text),
  public.evaluate_submission(uuid),
  public.decide_renewal(uuid,text,text),
  public.dashboard_stats(text,int)
to authenticated;
