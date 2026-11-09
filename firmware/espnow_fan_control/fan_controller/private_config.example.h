#pragma once

// Use the same randomly generated key in all three logger private_config.h files
// and in fan_controller/private_config.h. At least 32 ASCII characters.
#define FAN_ESPNOW_KEY "SET_THE_SAME_RANDOM_32_BYTE_KEY_ON_ALL_FOUR_DEVICES"

// 0: D10 -> 4.7k -> NPN base; NPN collector -> active-LOW relay IN (recommended).
// 1: D10 -> relay IN directly, ONLY for a verified 3.3 V-compatible
//    active-LOW input that stays OFF while D10 is high impedance at reset.
// #define FAN_RELAY_DIRECT_ACTIVE_LOW 1
