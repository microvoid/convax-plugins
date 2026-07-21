cmake_minimum_required(VERSION 3.25)

project(
  convax_subtitle_erasure
  VERSION 0.1.2
  DESCRIPTION "Local AI hard-subtitle erasure sidecar for Convax Desktop"
  LANGUAGES CXX
)

if(WIN32)
  message(FATAL_ERROR "The P0 subtitle-erasure sidecar is not supported on Windows yet")
endif()

find_package(
  OpenCV 5.0 REQUIRED
  COMPONENTS core dnn geometry imgproc video videoio
)

add_executable(
  convax-subtitle-erasure
  src/main.cpp
  src/engine.cpp
  src/process.cpp
  src/protocol.cpp
)
set_target_properties(
  convax-subtitle-erasure
  PROPERTIES OUTPUT_NAME "subtitle-erasure"
)

target_compile_features(convax-subtitle-erasure PRIVATE cxx_std_20)
target_compile_definitions(
  convax-subtitle-erasure
  PRIVATE CONVAX_SUBTITLE_ERASURE_VERSION="${PROJECT_VERSION}"
)
target_include_directories(
  convax-subtitle-erasure
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
target_link_libraries(convax-subtitle-erasure PRIVATE ${OpenCV_LIBS})

if(CMAKE_CXX_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
  target_compile_options(
    convax-subtitle-erasure
    PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow
  )
endif()

include(GNUInstallDirs)
install(
  TARGETS convax-subtitle-erasure
  RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
)

include(CTest)
if(BUILD_TESTING)
  add_executable(
    convax-subtitle-erasure-protocol-test
    tests/protocol_test.cpp
    src/protocol.cpp
  )
  target_compile_features(convax-subtitle-erasure-protocol-test PRIVATE cxx_std_20)
  target_include_directories(
    convax-subtitle-erasure-protocol-test
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  if(CMAKE_CXX_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
    target_compile_options(
      convax-subtitle-erasure-protocol-test
      PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow
    )
  endif()
  add_test(NAME subtitle-erasure-protocol COMMAND convax-subtitle-erasure-protocol-test)

  add_executable(
    convax-subtitle-erasure-roi-test
    tests/roi_test.cpp
  )
  target_compile_features(convax-subtitle-erasure-roi-test PRIVATE cxx_std_20)
  target_include_directories(
    convax-subtitle-erasure-roi-test
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  if(CMAKE_CXX_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
    target_compile_options(
      convax-subtitle-erasure-roi-test
      PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow
    )
  endif()
  add_test(NAME subtitle-erasure-roi COMMAND convax-subtitle-erasure-roi-test)

  add_executable(
    convax-subtitle-erasure-roi-image-test
    tests/roi_image_test.cpp
  )
  target_compile_features(convax-subtitle-erasure-roi-image-test PRIVATE cxx_std_20)
  target_include_directories(
    convax-subtitle-erasure-roi-image-test
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  target_link_libraries(convax-subtitle-erasure-roi-image-test PRIVATE ${OpenCV_LIBS})
  if(CMAKE_CXX_COMPILER_ID MATCHES "AppleClang|Clang|GNU")
    target_compile_options(
      convax-subtitle-erasure-roi-image-test
      PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow
    )
  endif()
  add_test(NAME subtitle-erasure-roi-image COMMAND convax-subtitle-erasure-roi-image-test)

  add_test(NAME subtitle-erasure-version COMMAND convax-subtitle-erasure --version)
  set_tests_properties(
    subtitle-erasure-version
    PROPERTIES PASS_REGULAR_EXPRESSION "\\\"protocolVersion\\\":1"
  )
endif()
