//! The math functions as JavaScript's `Math` computes them in V8, where it
//! can be matched: `hypot` is V8's own algorithm (bit for bit), `tanh` is
//! fdlibm's (which V8 uses). V8's `sin`, `cos` and `atan2` are neither
//! correctly rounded nor musl's; `libm` (musl) is within 1 ulp of them (on
//! 400 000 values the sim meets, 2.5 % of `sin` results differ by 1 ulp).
//! Every function is platform-independent: the same bits natively and in
//! Wasm.

pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// `Math.hypot(x, y)` as V8 computes it: the largest magnitude, then a
/// Kahan-compensated sum of the squares scaled by it.
pub fn hypot(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    if ax.is_infinite() || ay.is_infinite() {
        return f64::INFINITY;
    }
    if ax.is_nan() || ay.is_nan() {
        return f64::NAN;
    }
    let max = ax.max(ay);
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for value in [ax, ay] {
        let n = value / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// fdlibm's `tanh` (s_tanh.c), as V8's `Math.tanh`.
pub fn tanh(x: f64) -> f64 {
    let jx = (x.to_bits() >> 32) as i32;
    let ix = jx & 0x7fff_ffff;
    if ix >= 0x7ff0_0000 {
        return if jx >= 0 { 1.0 / x + 1.0 } else { 1.0 / x - 1.0 };
    }
    let z = if ix < 0x4036_0000 {
        // |x| < 22
        if ix < 0x3c80_0000 {
            // |x| < 2^-55
            return x * (1.0 + x);
        }
        if ix >= 0x3ff0_0000 {
            let t = libm::expm1(2.0 * x.abs());
            1.0 - 2.0 / (t + 2.0)
        } else {
            let t = libm::expm1(-2.0 * x.abs());
            -t / (t + 2.0)
        }
    } else {
        1.0 - 1.0e-300
    };
    if jx >= 0 {
        z
    } else {
        -z
    }
}

/// `Math.sign` for a number that is not NaN.
pub fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `Math.max(a, b)` (a NaN wins; +0 over -0).
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_positive() { a } else { b };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` (a NaN wins; -0 over +0).
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b {
        a
    } else {
        b
    }
}
