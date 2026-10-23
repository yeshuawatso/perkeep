/*
Copyright 2012 The Perkeep Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package postgres

import (
	"strconv"

	"perkeep.org/pkg/sorted"
)

const requiredSchemaVersion = 2

func SchemaVersion() int {
	return requiredSchemaVersion
}

func SQLCreateTables() []string {
	return []string{
		// k's collation must be byte-order ("C"), not whatever locale the database
		// happened to be initialized with. sqlkv's Find/FindEnd (shared by this package and
		// mysql) iterate via "ORDER BY k" and rely on that being the same strict
		// lexicographic/byte-order sequence sorted.KeyValue documents and that SQLite's
		// default BINARY collation already gives for free -- a locale-aware collation
		// (en_US.utf8, the official postgres image's own default locale when no --locale is
		// passed to initdb) can order keys differently, e.g. by collapsing or reweighting
		// punctuation and digit runs. Verified live: switching an existing SQLite-backed
		// instance to a fresh postgres:15 container with its default locale reproducibly
		// panicked on startup with "Caught panic: dup blob seen" in index/corpus's
		// mergeMetaShard, which assumes rows arrive in that exact byte order.
		`CREATE TABLE IF NOT EXISTS rows (
 k VARCHAR(` + strconv.Itoa(sorted.MaxKeySize) + `) COLLATE "C" NOT NULL PRIMARY KEY,
 v VARCHAR(` + strconv.Itoa(sorted.MaxValueSize) + `))`,

		`CREATE TABLE IF NOT EXISTS meta (
 metakey VARCHAR(255) NOT NULL PRIMARY KEY,
 value VARCHAR(255) NOT NULL)`,
	}
}

func SQLDefineReplace() []string {
	return []string{
		// The first 3 statements here are a work around that allows us to issue
		// the "CREATE LANGUAGE plpsql;" statement only if the language doesn't
		// already exist.
		`CREATE OR REPLACE FUNCTION create_language_plpgsql() RETURNS INTEGER AS
$$
CREATE LANGUAGE plpgsql;
SELECT 1;
$$
LANGUAGE SQL;`,

		`SELECT CASE WHEN NOT
(
	SELECT  TRUE AS exists
	FROM    pg_language
	WHERE   lanname = 'plpgsql'
	UNION
	SELECT  FALSE AS exists
	ORDER BY exists DESC
	LIMIT 1
)
THEN
    create_language_plpgsql()
ELSE
	0
END AS plpgsql_created;`,

		`DROP FUNCTION create_language_plpgsql();`,

		`CREATE OR REPLACE FUNCTION replaceinto(key TEXT, value TEXT) RETURNS VOID AS
$$
BEGIN
    LOOP
        UPDATE rows SET v = value WHERE k = key;
        IF found THEN
            RETURN;
        END IF;
        BEGIN
            INSERT INTO rows(k,v) VALUES (key, value);
            RETURN;
        EXCEPTION WHEN unique_violation THEN
        END;
    END LOOP;
END;
$$
LANGUAGE plpgsql;`,
		`CREATE OR REPLACE FUNCTION replaceintometa(key TEXT, val TEXT) RETURNS VOID AS
$$
BEGIN
    LOOP
        UPDATE meta SET value = val WHERE metakey = key;
        IF found THEN
            RETURN;
        END IF;
        BEGIN
            INSERT INTO meta(metakey,value) VALUES (key, val);
            RETURN;
        EXCEPTION WHEN unique_violation THEN
        END;
    END LOOP;
END;
$$
LANGUAGE plpgsql;`,
	}
}
