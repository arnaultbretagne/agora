\set ON_ERROR_STOP on

DO $$
DECLARE
  observed text;
BEGIN
  SELECT '{"used":9007199254740993}'::jsonb ->> 'used'
    INTO observed;

  IF observed <> '9007199254740993' THEN
    RAISE EXCEPTION
      'jsonb changed schema-valid ACP uint64: expected %, observed %',
      '9007199254740993',
      observed;
  END IF;
END
$$;
