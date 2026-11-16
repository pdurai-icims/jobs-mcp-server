CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    req_id text UNIQUE,
    legacy_id text UNIQUE,
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    description text NOT NULL CHECK (length(btrim(description)) > 0),
    experience text,
    city text,
    state text,
    country text,
    skills text[] NOT NULL DEFAULT '{}',
    employment_type text,
    job_type text,
    industry text,
    education_level text,
    salary_value double precision CHECK (
        salary_value >= 0 AND salary_value < 'Infinity'::double precision
    ),
    salary_currency text CHECK (salary_currency ~ '^[A-Z]{3}$'),
    searchable boolean NOT NULL DEFAULT true,
    applyable boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX jobs_created_at_idx ON jobs (created_at DESC, id);
