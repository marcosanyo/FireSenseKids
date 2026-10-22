# =============================================================================
# FireSense Kids — Makefile
#
# Requires only Docker and the Android SDK (for the emulator). Node, Terraform, the AWS CLI and
# Gradle all run in Docker. AWS credentials are read from .env (see .env.example).
#
# Usual flow
#   make emu-start      start the Fire TV emulator (cold boot; waits until it has booted)
#   make deploy         deploy to AWS -> build the APK -> reinstall and launch it on the running emulator
#   make emu-stop       stop the emulator when done (saves CPU and heat)
#
# Emulator
#   make emu-start      start it; does nothing if it is already running
#                       EMU_HEADLESS=1 make emu-start   no window (lighter when not recording)
#                       EMU_CORES=4 make emu-start      CPU cores (default 2; more is faster and hotter)
#   make emu-stop       stop it (adb emu kill) and wait until it has stopped
#   make emu-status     whether it is running, the Android clock, and the app in front
#   make emu            emu-start + install-apk (to try quickly when an APK already exists)
#   Note: the TV rendering benchmark and the relay round-trip probe start from the remote: OK -> measurement menu
#     (fast-forward / rewind seek the video, left / right switch videos)
#   make upload-media   fetch and transcode the preset videos (Blender open movies) into S3 media/
#   make upload-models  fetch and verify the watch camera's RTMO pose models into S3 models/
#
#   Note: always a cold boot (no snapshot). Restoring a snapshot sets the Android clock back to when it was saved,
#     and HTTPS certificate date checks fail (ERR_CERT_DATE_INVALID -> "Failed to fetch" when saving the records).
#     It also avoids DNS breaking after sleep.
#
# APK
#   make apk            build the APK with /tv from out/ bundled (the web build that make deploy exported)
#   make install-apk    reinstall and launch on every device connected to adb
#                       FIRETV_IP=192.168.x.x make install-apk   a real Fire TV (turn ADB debugging on first)
#
# Development
#   make test           unit tests + type check (with AWS credentials, the live Bedrock test runs too)
#   make tf-validate    bundle the Lambdas and run terraform validate
#   make clean          remove build output
# =============================================================================

.PHONY: test build-lambda tf-validate deploy apk install-apk emu emu-start emu-stop emu-status upload-media upload-models clean

# All Node tasks run in Docker; see scripts/deploy.sh.
DN = docker run --rm -i -v "$(CURDIR)":/app -v firesense-nm:/app/node_modules -v firesense-npm-cache:/root/.npm -w /app node:22 bash -lc

ANDROID_SDK ?= $(HOME)/Library/Android/sdk
ADB         ?= $(ANDROID_SDK)/platform-tools/adb
EMULATOR    ?= $(ANDROID_SDK)/emulator/emulator
AVD         ?= FireTV_1080p
EMU_CORES   ?= 2
EMU_LOG     ?= /tmp/firesense-emulator.log

test:
	$(DN) "npm ci --no-audit --no-fund >/dev/null && npx vitest run tests && npx tsc --noEmit"

build-lambda:
	$(DN) "node infra/lambda/build.mjs"

tf-validate: build-lambda
	docker run --rm -v "$(CURDIR)":/repo -w /repo/infra/terraform hashicorp/terraform:1.9 init -backend=false -input=false
	docker run --rm -v "$(CURDIR)":/repo -w /repo/infra/terraform hashicorp/terraform:1.9 validate

deploy:
	bash scripts/deploy.sh

apk:
	bash scripts/package-tv-assets.sh && bash scripts/build-apk.sh

# Reinstall + launch on all adb devices (FIRETV_IP=<ip> to connect a real Fire TV first)
install-apk:
	bash scripts/install-apk.sh

# --- Fire TV emulator ---------------------------------------------------------
emu-start:
	@if $(ADB) devices | grep -q '^emulator-.*device$$'; then \
	  echo "emulator already running"; \
	else \
	  echo "starting $(AVD) (cold boot, $(EMU_CORES) cores, log: $(EMU_LOG))"; \
	  nohup $(EMULATOR) -avd $(AVD) -no-snapshot -no-boot-anim -cores $(EMU_CORES) \
	    $(if $(EMU_HEADLESS),-no-window -no-audio,) > $(EMU_LOG) 2>&1 & \
	  $(ADB) wait-for-device; \
	  until [ "$$($(ADB) shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done; \
	  echo "booted: $$($(ADB) shell date | tr -d '\r')"; \
	fi

emu-stop:
	@if $(ADB) devices | grep -q '^emulator-'; then \
	  $(ADB) emu kill >/dev/null; \
	  while $(ADB) devices | grep -q '^emulator-'; do sleep 1; done; \
	  echo "emulator stopped"; \
	else \
	  echo "emulator is not running"; \
	fi

emu-status:
	@if $(ADB) devices | grep -q '^emulator-.*device$$'; then \
	  echo "running"; \
	  echo "  android time: $$($(ADB) shell date | tr -d '\r')   (host: $$(date))"; \
	  $(ADB) shell dumpsys activity activities | grep -m1 mResumedActivity | sed 's/^ */  foreground: /'; \
	else \
	  echo "not running"; \
	fi

emu: emu-start install-apk

# Measurement keys for remotes / emulators without ⏩ ⏪ (KEYCODE_MEDIA_FAST_FORWARD=90, REWIND=89)
upload-media:
	bash scripts/upload-media.sh

upload-models:
	bash scripts/upload-models.sh

clean:
	rm -rf .next out infra/lambda/dist infra/terraform/.build firetv-app/app/build
