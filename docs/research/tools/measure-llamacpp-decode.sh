#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <base-url-with-v1> <model-id> <output-dir>" >&2
  exit 2
fi

base_url=${1%/}
model_id=$2
output_dir=$3
prompt_file=${PROMPT_FILE:-}
warmups=${WARMUPS:-2}
repeats=${REPEATS:-5}
max_tokens=${MAX_TOKENS:-512}
temperature=${TEMPERATURE:-0}
seed=${SEED:-42}

if [[ -z "$prompt_file" || ! -f "$prompt_file" ]]; then
  echo "PROMPT_FILE must point to a frozen UTF-8 prompt file" >&2
  exit 2
fi
if ! [[ "$warmups" =~ ^[0-9]+$ && "$repeats" =~ ^[1-9][0-9]*$ && "$max_tokens" =~ ^[1-9][0-9]*$ ]]; then
  echo "WARMUPS, REPEATS and MAX_TOKENS must be non-negative/positive integers" >&2
  exit 2
fi
if [[ -e "$output_dir" ]] && find "$output_dir" -mindepth 1 -print -quit | grep -q .; then
  echo "output directory already contains data; choose a new immutable run directory: $output_dir" >&2
  exit 2
fi

mkdir -p "$output_dir/responses"

jq -n \
  --arg model "$model_id" \
  --rawfile prompt "$prompt_file" \
  --argjson max_tokens "$max_tokens" \
  --argjson temperature "$temperature" \
  --argjson seed "$seed" \
  '{model:$model,messages:[{role:"user",content:$prompt}],max_tokens:$max_tokens,temperature:$temperature,seed:$seed,stream:false}' \
  > "$output_dir/request.json"

{
  date --iso-8601=seconds
  uname -a
  nvidia-smi --query-gpu=index,name,driver_version,pstate,clocks.current.sm,clocks.current.memory,power.draw,power.limit,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.free --format=csv
  nvidia-smi topo -m
} > "$output_dir/environment.txt"

nvidia-smi \
  --query-gpu=timestamp,index,pstate,clocks.current.sm,clocks.current.memory,power.draw,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.free \
  --format=csv,noheader,nounits -lms 200 > "$output_dir/gpu-samples.csv" &
sampler_pid=$!
cleanup() {
  kill "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

run_one() {
  local phase=$1
  local index=$2
  local response_file="$output_dir/responses/${phase}-$(printf '%03d' "$index").json"
  local curl_file
  curl_file=$(mktemp)
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}\t%{time_connect}\t%{time_starttransfer}\t%{time_total}\t%{size_download}\n' \
    "$base_url/chat/completions" \
    -H 'Content-Type: application/json' \
    --data-binary "@$output_dir/request.json" > "$curl_file"

  if [[ "$phase" == "measure" ]]; then
    IFS=$'\t' read -r http_code connect_s first_byte_s total_s bytes < "$curl_file"
    jq -c \
      --arg phase "$phase" \
      --argjson request_index "$index" \
      --arg http_code "$http_code" \
      --arg connect_s "$connect_s" \
      --arg first_byte_s "$first_byte_s" \
      --arg total_s "$total_s" \
      --arg bytes "$bytes" \
      '{
        phase:$phase,
        request_index:$request_index,
        http_code:($http_code|tonumber),
        http_connect_s:($connect_s|tonumber),
        http_first_byte_s:($first_byte_s|tonumber),
        http_total_s:($total_s|tonumber),
        response_bytes:($bytes|tonumber),
        model:(.model // ""),
        finish_reason:(.choices[0].finish_reason // ""),
        prompt_tokens_total:(.usage.prompt_tokens // .timings.prompt_n // 0),
        prompt_tokens_evaluated:(.timings.prompt_n // .usage.prompt_tokens // 0),
        cached_tokens:(.usage.prompt_tokens_details.cached_tokens // 0),
        decoded_tokens:(.timings.predicted_n // .usage.completion_tokens // 0),
        prompt_ms:(.timings.prompt_ms // null),
        prompt_tps:(.timings.prompt_per_second // null),
        decode_ms:(.timings.predicted_ms // null),
        decode_tps:(.timings.predicted_per_second // null),
        error:(.error // null)
      }' "$response_file" >> "$output_dir/timings.jsonl"
  fi
  rm -f "$curl_file"
}

for ((i = 1; i <= warmups; i++)); do
  run_one warmup "$i"
done
for ((i = 1; i <= repeats; i++)); do
  run_one measure "$i"
done

cleanup
trap - EXIT INT TERM

jq -Rn '
  [inputs
   | split(",")
   | map(gsub("^ +| +$"; ""))
   | {
       gpu_index:(.[1] | tonumber),
       sm_clock_mhz:(.[3] | tonumber),
       power_w:(.[5] | tonumber),
       temperature_c:(.[6] | tonumber),
       gpu_util_pct:(.[7] | tonumber)
     }]
  | group_by(.gpu_index)
  | map({
      gpu_index:.[0].gpu_index,
      samples:length,
      gpu_util_pct:{min:(map(.gpu_util_pct)|min),avg:(map(.gpu_util_pct)|add/length),max:(map(.gpu_util_pct)|max)},
      power_w:{min:(map(.power_w)|min),avg:(map(.power_w)|add/length),max:(map(.power_w)|max)},
      sm_clock_mhz:{min:(map(.sm_clock_mhz)|min),avg:(map(.sm_clock_mhz)|add/length),max:(map(.sm_clock_mhz)|max)},
      temperature_c:{min:(map(.temperature_c)|min),avg:(map(.temperature_c)|add/length),max:(map(.temperature_c)|max)}
    })
' "$output_dir/gpu-samples.csv" > "$output_dir/gpu-summary.json"

jq -s '
  def stats:
    sort as $s
    | if length == 0 then {values:[],min:null,median:null,max:null}
      else {
        values:$s,
        min:$s[0],
        median:(if ($s|length)%2==1 then $s[(($s|length)/2|floor)]
                else (($s[(($s|length)/2)-1]+$s[(($s|length)/2)])/2) end),
        max:$s[-1]
      } end;
  {
    samples:length,
    http_ok:([.[]|select(.http_code==200)]|length),
    decode_tps:([.[].decode_tps|select(.!=null)]|stats),
    prompt_tps:([.[].prompt_tps|select(.!=null)]|stats),
    total_s:([.[].http_total_s]|stats)
  }
' "$output_dir/timings.jsonl" > "$output_dir/summary.json"

echo "saved: $output_dir"
