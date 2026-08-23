# Site Mirror

A tool that downloads and rebuilds a fully offline, locally-runnable copy of a given website. It
renders the page's JavaScript, fetches every asset the page needs (styles, scripts, fonts, images,
video, audio), and rewrites all references so the mirrored copy runs without an internet
connection. Crawling respects the target site's robots.txt and never attempts to bypass any bot
protection, CAPTCHA, or access control it encounters — those cases are stopped and recorded in an
error report instead.
