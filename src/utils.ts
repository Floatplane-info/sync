export function wait(ms: number) {
    return new Promise((res) => {
        setTimeout(res, Math.floor(ms));
    });
}

export function random(min: number, max: number, int = false) {
    const rand = (Math.random() * (max - min)) + min;
    return int ? Math.floor(rand) : rand;
}

export async function retry<T>(run: () => Promise<T>, shouldRetry = (err: any, n: number) => n <= 7): Promise<T> {
    const start = Date.now();
    let err: unknown | undefined = undefined;
    let attempt = 0;
    do {
        attempt++;
        try {
            const r = await run();
            return r;
        } catch(e) {
            console.warn(`[${start.toString(36)}] Got error on attempt #` + attempt, e)
            err = e;
            if(attempt >= 2) {
                await wait(100 * (attempt-1));
            }
        }
    } while(shouldRetry(err, attempt));

    console.warn(`[${start.toString(36)}] Giving up after ${attempt} attempt${attempt === 1 ? "" : "s"}!`);
    throw err;
}

export function commas(x: number | undefined | null, decimals?: undefined | number) {
    if(typeof x === "undefined" || x === null) return x;
    const parts = (typeof decimals === "undefined" ? x.toString() : x.toFixed(decimals ?? 100))
        .split(".")
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (parts.length > 1 ? "." : "") + parts.slice(1).join(".");
}