// i18n.js — Internationalization helper for TrafficDrive dashboard.
//
// Provides:
//   - t(key)            : translate a key to the active language (falls back
//                         to the original English text found in the DOM, then
//                         to the key itself).
//   - initLanguage()    : build the English fallback map from [data-i18n]
//                         elements and apply the saved/selected language.
//   - changeLanguage()  : switch the active language and re-render the UI.
//   - applyTranslations(): re-apply all data-i18n / data-i18n-ph attributes.
//
// Translations for non-English languages are stored in the LANGS object below.
// Only keys that differ from English need to be provided; missing keys fall
// back to the English text harvested from the DOM.

(function () {
  'use strict';

  // English fallback map: key -> text. Populated from the DOM on init.
  const EN = {};

  // Active language code ('en' by default).
  let currentLang = 'en';

  // -----------------------------------------------------------------------
  // Translation dictionaries. Add more languages here as needed.
  // Keys not present fall back to the English text harvested from the DOM.
  // -----------------------------------------------------------------------
  const LANGS = {
    en: {
      on_status: 'ON',
      off_status: 'OFF',
      system_on: 'System is ON',
      system_off: 'System is OFF',
    },
    ur: {
      nav_dashboard: 'ڈیش بورڈ',
      nav_campaigns: 'کیمپینز',
      nav_proxies: 'پراکسیز',
      nav_settings: 'سیٹنگز',
      nav_scroll_system: 'اسکرول سسٹم',
      nav_internal_links: 'اندرونی لنکس',
      nav_resolutions: 'اسکرین ریزولوشن',
      nav_useragents: 'یوزر ایجنٹس',
      nav_privacy: 'پرائیویسی',
      nav_browsers: 'براؤزرز',
      nav_rpa: 'آر پی اے آٹومیشن',
      nav_schedule: 'شیڈول',
      nav_logs: 'لاگز',
      nav_help: 'مدد',
      sys_status: 'سسٹم اسٹیٹس',
      status: 'اسٹیٹس',
      active_sessions: 'ایکٹو سیشنز',
      total_visits: 'کل وزٹس',
      uptime: 'اپ ٹائم',
      dark_mode: 'ڈارک موڈ',
      connected: 'کنیکٹڈ',
      refresh: 'ریفریش',
      traffic_settings: 'ٹریفک سیٹنگز',
      website_url: 'ویب سائٹ یو آر ایل',
      keywords: 'کی ورڈز (ایک فی لائن)',
      num_sessions: 'سیشنز کی تعداد',
      pages_session: 'فی سیشن پیجز',
      delay_time: 'دیر (سیکنڈ)',
      to: 'سے',
      max_visits: 'زیادہ سے زیادہ وزٹس',
      concurrent_threads: 'ایک ساتھ چلنے والے تھریڈز',
      headless_mode: 'براؤزر موڈ',
      opt_vis_debug: 'ویزیبل',
      opt_headless: 'ہیڈ لیس',
      traffic_mode: 'ٹریفک موڈ',
      organic_search: 'آرگینک سرچ',
      direct_traffic: 'ڈائریکٹ ٹریفک',
      referral_traffic: 'ریفرل ٹریفک',
      gmaps_traffic: 'گوگل میپس ٹریفک',
      device_settings: 'ڈیوائس سیٹنگز',
      desktop: 'ڈیسک ٹاپ',
      mobile: 'موبائل',
      user_agent: 'یوزر ایجنٹ',
      opt_random: 'رینڈم (تجویز کردہ)',
      opt_auto: 'آٹو (سسٹم ڈیفالٹ)',
      opt_custom: 'کسٹم...',
      visit_time_control: 'وزٹ ٹائم کنٹرول',
      auto_loop: 'آٹو لوپ',
      auto_loop_off: 'بند — کیمپین مکمل ہونے پر رک جائے گی',
      ref_traffic_platform: 'ریفرنس ٹریفک پلیٹ فارم',
      gmaps_settings: 'گوگل میپس سیٹنگز',
      biz_name: 'کاروبار / ریستوران کا نام',
      biz_url: 'کاروبار ویب سائٹ یو آر ایل',
      search_engines: 'سرچ انجنز',
      primary_engine: 'پرائمری سرچ انجن',
      available_engines: 'دستیاب سرچ انجنز',
      add_custom_engine: 'کسٹم سرچ انجن شامل کریں',
      add: 'شامل کریں',
      remove: 'ہٹائیں',
      create_campaign: 'نئی کیمپین بنائیں',
      cancel: 'منسوخ',
      campaign_name: 'کیمپین کا نام',
      target_url: 'ٹارگٹ یو آر ایل',
      traffic_mode_label: 'ٹریفک موڈ',
      sessions_target: 'سیشنز ٹارگٹ',
      keywords_label: 'کی ورڈز',
      save: 'محفوظ کریں',
      sessions: 'سیشنز',
      visits: 'وزٹس',
      active: 'ایکٹو',
      run: 'چلائیں',
      delete: 'حذف',
      stopped: 'بند',
      paste_proxy_list: 'پراکسی لسٹ پیسٹ کریں',
      app_language: 'ایپلیکیشن زبان',
      timezone: 'ٹائم زون',
      browser_engine: 'براؤزر انجن',
      opt_chromium: 'کرومیئم (بنڈلڈ)',
      opt_edge: 'مائیکروسافٹ ایج',
      opt_chrome: 'گوگل کروم',
      opt_custom_path: 'کسٹم پاتھ',
      custom_browser_path: 'کسٹم براؤزر پاتھ',
      headless_mode_label: 'ہیڈ لیس موڈ',
      browser_settings: 'براؤزر سیٹنگز',
      browser_behavior: 'براؤزر رویہ',
      browser: 'براؤزر',
      ua_search: 'یوزر ایجنٹس سرچ',
      ua_select_all: 'سب منتخب کریں',
      ua_deselect_all: 'سب deselect کریں',
      ua_apply_selected: 'منتخب شدہ لگائیں',
      ua_count_label: 'منتخب',
      ua_auto_rotate_title: 'آٹو روٹیٹ یوزر ایجنٹس',
      ua_enable_auto_rotate: 'آٹو روٹیٹ فعال کریں',
      ua_rotate_mode: 'روٹیٹ موڈ',
      ua_randomly_choose: 'رینڈملی منتخب',
      ua_sequential_one: 'ترتیب وار (ایک ایک)',
      ua_rotate_per_thread: 'فی تھریڈ کاؤنٹ روٹیٹ',
      ua_auto_rotate_hint: 'جب آٹو روٹیٹ آن ہو، ہر تھریڈ آپ کی منتخب لسٹ سے رینڈم یوزر ایجنٹ استعمال کرے گا۔',
      ua_test_auto_rotate: 'آٹو روٹیٹ ٹیسٹ (پریویو)',
      ua_load_more: 'مزید لوڈ کریں',
      priv_active_protections: 'ایکٹو پروٹیکشنز',
      priv_inactive: 'غیر فعال',
      priv_total_features: 'کل فیچرز',
      priv_shield_level: 'شیلڈ لیول',
      priv_enable_all: 'سب فعال کریں',
      priv_disable_all: 'سب غیر فعال کریں',
      priv_stealth: 'اسٹیلتھ',
      priv_balanced: 'بیلنسڈ',
      priv_enabled_count: 'فعال',
      br_total_browsers: 'کل براؤزرز',
      br_chromium_based: 'کرومیئم بیسڈ',
      br_firefox_based: 'فائر فاکس بیسڈ',
      br_other_engines: 'دیگر انجنز',
      browsers: 'براؤزرز',
      install: 'انسٹال',
      get_from_web: 'ویب سے حاصل کریں',
      website: 'ویب سائٹ',
      br_add_custom: 'کسٹم ایڈ کریں',
      br_add_custom_browser: 'کسٹم براؤزر ایڈ کریں',
      br_custom_name: 'براؤزر کا نام',
      br_custom_name_ph: 'مائی براؤزر',
      br_custom_path: 'براؤزر پاتھ (.exe)',
      br_custom_path_ph: 'C:\\Program Files\\Browser\\browser.exe',
      br_add: 'ایڈ کریں',
      br_browse: 'براؤز کریں',
      br_fill_name_path: 'براؤزر کا نام اور پاتھ درج کریں',
      br_custom_added: 'کسٹم براؤزر ایڈ ہو گیا',
      br_add_failed: 'براؤزر ایڈ ناکام',
      br_confirm_remove: 'کیا آپ یہ براؤزر ہٹانا چاہتے ہیں؟',
      br_custom_removed: 'کسٹم براؤزر ہٹا دیا گیا',
      br_launched: 'براؤزر لانچ ہو گیا',
      br_launch_failed: 'براؤزر لانچ ناکام',
      br_enter_path: 'براؤزر کا پاتھ درج کریں',
      browser_installed: 'براؤزر انسٹال ہو گیا',
      installing_browser: 'براؤزر انسٹال ہو رہا ہے',
      install_failed: 'انسٹال ناکام',
      install_request_failed: 'انسٹال درخواست ناکام',
      starting_download: 'ڈاؤن لوڈ شروع ہو رہا ہے',
      downloaded: 'ڈاؤن لوڈ ہو گیا',
      remaining: 'باقی',
      left: 'باقی',
      extracting: 'نکال رہا ہے',
      installed: 'انسٹال ہو گیا',
      failed: 'ناکام',
      settings_saved: 'سیٹنگز محفوظ ہوگئیں',
      settings_updated: 'سیٹنگز اپ ڈیٹ ہوگئیں',
      reset_all: 'سب سیٹنگز ری سیٹ',
      reset_desc: 'یہ سب کچھ فیکٹری ڈیفالٹ پر ری سیٹ کر دے گا۔',
      confirm_reset: 'کیا آپ واقعی سب ری سیٹ کرنا چاہتے ہیں؟',
      on_status: 'آن',
      off_status: 'بند',
      running_status: 'چل رہی ہے',
      paused_status: 'روکی ہوئی',
      stopped_status: 'بند',
      idle: 'بیکار',
      thread_count_updated: 'تھریڈ کاؤنٹ اپ ڈیٹ',
      il_nav_enabled: 'اندرونی لنکس نیویگیشن فعال',
      il_nav_disabled: 'اندرونی لنکس نیویگیشن غیر فعال',
      il_current_status: 'موجودہ اسٹیٹس:',
      nav_random_clicks: 'رینڈم کلکس',
      rc_title: 'رینڈم کلکس',
      rc_desc: 'ویزٹ ٹائم کے دوران صفحے پر رینڈم کلکس، اسکرول اور ریفریش',
      rc_how_title: 'کیسے کام کرتا ہے:',
      rc_how_body: 'ویزٹ کے دوران پہلا کلک X سیکنڈ بعد، پھر Y کلکس (ہر کلک کے درمیان وقفہ)، پھر اگلے برسٹ سے پہلے بریک۔ سب کچھ ویزٹ ٹائم کے اندر۔',
      rc_how_bg: 'لنک نئے ٹیب میں بیک گراؤنڈ میں کھلتا ہے — آپ کا صفحہ سامنے رہتا ہے اور Back کام کرتا ہے۔',
      rc_preset_slow: 'آہستہ',
      rc_preset_normal: 'نارمل',
      rc_preset_fast: 'تیز',
      rc_initial_delay: 'پہلا کلک بعد میں (سیکنڈ)',
      rc_max: 'کل کلک کی حد (0 = لامحدود)',
      rc_burst_min: 'ایک برسٹ میں کلکس (کم از کم)',
      rc_burst_max: 'ایک برسٹ میں کلکس (زیادہ سے زیادہ)',
      rc_burst_hint: 'ایک برسٹ میں اتنے کلکس ایک ساتھ (اسی رینج میں رینڈم)',
      rc_click_gap_min: 'کلکس کے درمیان وقفہ (ms، کم از کم)',
      rc_click_gap_max: 'کلکس کے درمیان وقفہ (ms، زیادہ سے زیادہ)',
      rc_click_gap_hint: 'ہر کلک کے درمیان اتنا وقت (1000 ms = 1 سیکنڈ)',
      rc_interval_min: 'برسٹس کے درمیان وقفہ (سیکنڈ، کم از کم)',
      rc_interval_max: 'برسٹس کے درمیان وقفہ (سیکنڈ، زیادہ سے زیادہ)',
      rc_interval_hint: 'ایک برسٹ ختم ہونے کے بعد اتنا بریک (اسی رینج میں رینڈم)',
      rc_scroll_enabled: 'کلکس کے بعد اسکرول',
      rc_scroll_amount: 'اسکرول کی مقدار (px)',
      rc_scroll_dir: 'اسکرول کی سمت',
      rc_dir_down: 'نیچے',
      rc_dir_up: 'اوپر',
      rc_dir_random: 'رینڈم',
      rc_refresh_enabled: 'رینڈم صفحہ ریفریش',
      rc_refresh_min: 'ریفریش ہر (کم از کم سیکنڈ)',
      rc_refresh_max: 'ریفریش ہر (زیادہ سے زیادہ سیکنڈ)',
      rc_revert_nav: 'اگر کلک صفحہ بدل دے تو وزٹ شدہ صفحے پر واپس آئیں (تجویز کردہ)',
      rc_summary_title: 'خلاصہ:',
      rc_summary_line: 'پہلا کلک X سیکنڈ بعد · Y کلکس (وقفہ) · پھر بریک · حد',
      rc_summary_bg: 'لنک بیک گراؤنڈ ٹیب میں کھلیں گے — وزٹ شدہ صفحہ سامنے رہے گا۔',
      rc_summary_revert: 'اگر صفحہ بدل جائے تو وزٹ شدہ صفحے پر واپس۔',
      rc_enable: 'فعال کریں',
      rc_disable: 'غیر فعال کریں',
      rc_current_status: 'موجودہ اسٹیٹس:',
      rc_adonly_title: 'صرف اشتہارات پر کلک کریں',
      rc_adonly_badge: 'تجویز کردہ',
      rc_adonly_sub: 'صرف وہ اشتہارات کلک ہوں گے جو اسکرین پر واقعی نظر آ رہے ہیں اور چل رہے ہیں۔ خالی، پوشیدہ، blank یا 1×1 اشتہار کبھی کلک نہیں ہوں گے — صفحے کی خالی جگہ پر بھی کلک نہیں ہوگا۔ ہر موڈ (ڈائریکٹ / آرگینک / ریفرل / میپس) اور RPA ری پلے میں کام کرتا ہے۔',
      rc_adonly_tag: 'صرف اشتہار',
      rc_adonly_summary: 'صرف اشتہار: صرف نظر آنے والے اور چلنے والے اشتہاری سلاٹس کلک ہوں گے۔ خالی، پوشیدہ، blank یا 1×1 سلاٹ اور عام صفحہ نظر انداز ہو جائے گا۔',
      il_links_after_scroll: 'اسکرول کے بعد لنکس',
      delay: 'دیر',
      read_time: 'ریڈ ٹائم',
      il_preview: 'پریویو',
      il_links_will_open: 'لنکس کھلیں گے',
      il_each_link: 'ہر لنک',
      il_link: 'لنک',
      il_link_desc: 'کھلا اور پڑھا جائے گا',
      il_total_time: 'کل ٹائم',
      visit_time_saved: 'وزٹ ٹائم محفوظ',
      vt_main_page: 'مین پیج',
      vt_internal_link: 'اندرونی لنک',
      maps_timing_log: 'میپس ٹائمنگ',
      direct_mode_selected: 'ڈائریکٹ موڈ منتخب',
      gmaps_mode_selected: 'گوگل میپس موڈ منتخب',
      organic_mode_selected: 'آرگینک سرچ موڈ منتخب',
      mobile_mode_log: 'موبائل موڈ',
      desktop_mode_log: 'ڈیسک ٹاپ موڈ',
      threads_label: 'تھریڈز',
      browser_mode_log: 'براؤزر موڈ',
      enter_engine_name_url: 'انجن کا نام اور یو آر ایل درج کریں',
      custom_engine_added: 'کسٹم انجن شامل',
      confirm_remove_engine: 'کیا ہٹائیں',
      engine_removed: 'انجن ہٹایا',
      engines_saved_log: 'انجنز محفوظ',
      no_proxies_validate: 'ویلیڈیٹ کرنے کے لیے پراکسیز نہیں',
      validating_proxies: 'پراکسیز ویلیڈیٹ ہو رہی ہیں',
      validation_done: 'ویلیڈیشن مکمل',
      auto_loop_on: 'آن — کیمپین دوبارہ شروع',
      auto_loop_enabled_log: 'آٹو لوپ فعال',
      auto_loop_off: 'بند — کیمپین مکمل ہونے پر رک جائے گی',
      auto_loop_disabled_log: 'آٹو لوپ غیر فعال',
      enter_website_url: 'ویب سائٹ یو آر ایل درج کریں',
      enter_keywords_organic: 'آرگینک سرچ کے لیے کی ورڈز درج کریں',
      enter_biz_name_gmaps: 'گوگل میپس کے لیے کاروبار کا نام درج کریں',
      campaign_started_log: 'کیمپین شروع',
      mode_label: 'موڈ',
      default_sessions: 'ڈیفالٹ سیشنز',
      auto_loop_on_log: 'آٹو لوپ آن',
      ref_platform_log: 'ریفر پلیٹ فارم',
      proxies_available_log: 'پراکسیز دستیاب',
      no_proxies_backend: 'بیک اینڈ پر کوئی پراکسیز نہیں',
      ua_selected_log: 'یوزر ایجنٹس منتخب',
      privacy_log: 'پرائیویسی',
      visit_time_log: 'وزٹ ٹائم',
      starting_organic: 'آرگینک سرچ شروع ہو رہی ہے',
      il_links_log: 'اندرونی لنکس',
      organic_started: 'آرگینک سرچ شروع ہوگئی',
      failed_start_organic: 'آرگینک سرچ شروع ناکام',
      api_connection_failed: 'API کنیکشن ناکام',
      starting_direct: 'ڈائریکٹ ٹریفک شروع ہو رہی ہے',
      direct_started: 'ڈائریکٹ ٹریفک شروع ہوگئی',
      failed_start_direct: 'ڈائریکٹ ٹریفک شروع ناکام',
      starting_referral: 'ریفرل ٹریفک شروع ہو رہی ہے',
      referral_started: 'ریفرل ٹریفک شروع ہوگئی',
      failed_start_referral: 'ریفرل ٹریفک شروع ناکام',
      starting_gmaps: 'گوگل میپس ٹریفک شروع ہو رہی ہے',
      browser_visible_log: 'براؤزر ویزیبل',
      proxies_bg_log: 'پراکسیز بیک گراؤنڈ',
      all_browsers_closed: 'تمام براؤزرز بند',
      campaign_stopped_log: 'کیمپین روکی گئی',
      campaign_paused_log: 'کیمپین روکی گئی',
      pause_failed: 'روکنے میں ناکام',
      campaign_paused_local: 'کیمپین مقامی طور پر روکی گئی',
      campaign_resumed_log: 'کیمپین دوبارہ شروع',
      resume_failed: 'دوبارہ شروع میں ناکام',
      campaign_resumed_local: 'کیمپین مقامی طور پر دوبارہ شروع',
      dashboard_refreshed: 'ڈیش بورڈ ریفریش',
      logs_cleared: 'لاگز صاف',
      all_logs_cleared: 'تمام لاگز صاف',
      logs_exported: 'لاگز ایکسپورٹ',
      confirm_delete_campaign: 'کیا کیمپین حذف کریں؟',
      campaign_not_found: 'کیمپین نہیں ملی',
      campaign_already_running: 'کیمپین پہلے سے چل رہی ہے',
      loading_campaign: 'کیمپین لوڈ',
      fill_campaign_name_url: 'کیمپین کا نام اور یو آر ایل درج کریں',
      campaign_category: 'کیٹیگری',
      cat_business: 'بزنس',
      cat_shop: 'شاپ',
      cat_restaurant: 'ریستوران',
      cat_keyword_ranking: 'کی ورڈ رینکنگ',
      cat_local_service: 'لوکل سروس',
      cat_ecommerce: 'ای کامرس',
      num_sessions: 'سیشنز کی تعداد',
      total_visits: 'کل وزٹس',
      active: 'ایکٹو',
      run: 'چلائیں',
      delete_btn: 'حذف',
      campaign_deleted: 'کیمپین حذف',
      campaign_saved: 'کیمپین محفوظ',
      campaigns_saved: 'محفوظ کیمپینز',
      campaigns_running_now: 'اب چل رہی ہیں',
      campaigns_all_time: 'اب تک',
      no_campaigns_title: 'ابھی کوئی کیمپین نہیں',
      no_campaigns_sub: 'شروع کرنے کے لیے اپنی پہلی کیمپین بنائیں۔ اعداد و شمار صفر رہیں گے جب تک کیمپین نہ چلے۔',
      no_proxies_load: 'لوڈ کرنے کے لیے پراکسیز نہیں',
      loaded: 'لوڈڈ',
      proxies_loaded_saved: 'پراکسیز لوڈ اور محفوظ',
      proxies_local_backend_fail: 'پراکسیز مقامی، بیک اینڈ ناکام',
      proxies_local_backend_unreachable: 'پراکسیز مقامی، بیک اینڈ تک نہیں پہنچا',
      validating_all_proxies: 'تمام پراکسیز ویلیڈیٹ',
      checking: 'چیک ہو رہا',
      successful: 'کامیاب',
      failed: 'ناکام',
      proxy_validation_failed: 'پراکسی ویلیڈیشن ناکام',
      validation_complete: 'ویلیڈیشن مکمل',
      proxy_validation_api_failed: 'پراکسی ویلیڈیشن API ناکام',
      no_proxies: 'کوئی پراکسیز نہیں',
      proxies_cleared: 'پراکسیز صاف',
      scraping_proxies: 'پراکسیز اسکریپ',
      scraped_proxies: 'پراکسیز اسکریپ مکمل',
      scrape_failed: 'اسکریپ ناکام',
      scrape_no_proxies: 'کوئی پراکسیز نہیں ملی',
      added_to_list: 'لسٹ میں شامل',
      system_on: 'سسٹم آن',
      system_off: 'سسٹم بند',
      scroll_system_activated: 'اسکرول سسٹم فعال',
      scroll_system_not_found: 'اسکرول سسٹم نہیں ملا',
      scroll_preview: 'اسکرول پریویو',
      pages_to_open: 'کھولنے کے پیجز',
      scroll_amount: 'اسکرول مقدار',
      stay_time: 'ری مین ٹائم',
      scroll_start_failed: 'اسکرول سسٹم شروع ناکام',
      scroll_error: 'اسکرول ایرر',
      resolution_category: 'ریزولوشن کیٹگری',
      ua_desktop: 'ڈیسک ٹاپ',
      ua_mobile: 'موبائل',
      resolution_set: 'ریزولوشن سیٹ',
      invalid_resolution: 'غلط ریزولوشن',
      resolution_reset_default: 'ریزولوشن ڈیفالٹ پر ری سیٹ',
      auto_rotate_enabled_log: 'آٹو روٹیٹ فعال',
      auto_rotate_disabled_log: 'آٹو روٹیٹ غیر فعال',
      testing_auto_rotate: 'آٹو روٹیٹ ٹیسٹ',
      thread_label: 'تھریڈ',
      auto_rotate_preview: 'آٹو روٹیٹ پریویو',
      mobile_threads_resolution_log: 'موبائل تھریڈز ریزولوشن',
      br_chromium: 'کرومیئم',
      br_firefox: 'فائر فاکس',
      br_other_engines: 'دیگر',
      br_other: 'دیگر',
      br_custom: 'کسٹم',
      run: 'چلائیں',
      clear: 'ہٹائیں',
    },
  };

  // -----------------------------------------------------------------------
  // Build the English fallback map by scanning all [data-i18n] elements.
  // This runs after the DOM is parsed (script is loaded at end of body).
  // -----------------------------------------------------------------------
  function buildEnglishMap() {
    EN.length = 0;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key && !EN[key]) {
        EN[key] = el.textContent.trim();
      }
    });
    // Also harvest placeholders.
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      const key = el.getAttribute('data-i18n-ph');
      if (key && !EN[key]) {
        EN[key] = el.getAttribute('placeholder') || '';
      }
    });
  }

  // -----------------------------------------------------------------------
  // t(key) — translate. Order of resolution:
  //   1. Active language dictionary (LANGS[currentLang][key])
  //   2. English fallback map harvested from DOM (EN[key])
  //   3. The key itself
  // -----------------------------------------------------------------------
  function t(key) {
    const lang = LANGS[currentLang];
    if (lang && Object.prototype.hasOwnProperty.call(lang, key)) {
      return lang[key];
    }
    if (EN[key]) return EN[key];
    return key;
  }

  // Expose t() globally so inline onclick handlers can use it.
  window.t = t;

  // -----------------------------------------------------------------------
  // applyTranslations() — re-render all [data-i18n] / [data-i18n-ph] elements
  // with the active language.
  // -----------------------------------------------------------------------
  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      const key = el.getAttribute('data-i18n-ph');
      if (key) el.setAttribute('placeholder', t(key));
    });
  }

  // -----------------------------------------------------------------------
  // initLanguage() — build the English map, read saved language, apply.
  // -----------------------------------------------------------------------
  function initLanguage() {
    buildEnglishMap();
    let saved = 'en';
    try { saved = localStorage.getItem('appLanguage') || 'en'; } catch (e) {}
    // Map full language names (from the <select>) to codes.
    const nameToCode = {
      english: 'en', urdu: 'ur', arabic: 'ar', spanish: 'es',
      indonesian: 'id', chinese: 'zh',
    };
    const lower = String(saved).toLowerCase();
    currentLang = nameToCode[lower] || (LANGS[lower] ? lower : 'en');
    applyTranslations();
    // Reflect the saved language in the <select> if present.
    const sel = document.getElementById('appLanguage');
    if (sel) {
      const codeToName = {};
      Object.keys(nameToCode).forEach((n) => { codeToName[nameToCode[n]] = n.charAt(0).toUpperCase() + n.slice(1); });
      const name = codeToName[currentLang];
      if (name) {
        for (let i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value.toLowerCase() === name.toLowerCase() ||
              sel.options[i].textContent.toLowerCase() === name.toLowerCase()) {
            sel.selectedIndex = i;
            break;
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // changeLanguage(nameOrCode) — switch language and re-render.
  // -----------------------------------------------------------------------
  function changeLanguage(nameOrCode) {
    const nameToCode = {
      english: 'en', urdu: 'ur', arabic: 'ar', spanish: 'es',
      indonesian: 'id', chinese: 'zh',
    };
    const lower = String(nameOrCode).toLowerCase();
    currentLang = nameToCode[lower] || (LANGS[lower] ? lower : 'en');
    try { localStorage.setItem('appLanguage', currentLang); } catch (e) {}
    applyTranslations();
  }

  // Expose globally.
  window.initLanguage = initLanguage;
  window.changeLanguage = changeLanguage;
  window.applyTranslations = applyTranslations;
  window.__i18nGetCurrentLang = () => currentLang;
})();
